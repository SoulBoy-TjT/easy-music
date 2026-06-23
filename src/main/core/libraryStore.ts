import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isReusableDownloadedAudioFile } from './audioValidation'
import { extForQuality, normalizeCompareText } from './naming'
import { PLATFORM_LABELS, type Album, type DownloadStatus, type DownloadStore, type DownloadTask, type Platform, type Playlist, type PlaylistSongRow, type Quality, type Song } from './types'

const TOTAL_PRIMARY_PLATFORMS = ['kg', 'tx', 'wy']
const TOTAL_DOWNLOAD_CANDIDATE_PLATFORMS = ['kg', 'tx', 'wy', 'kw']

export interface MusicSourceRecord {
  id: string
  name: string
  script: string
  enabled: boolean
  sources: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface ReplaceArtistPlaylistsOptions {
  preservePlatforms?: Platform[]
}

export class LibraryStore implements DownloadStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  replaceArtistPlaylists(artistName: string, platformAlbums: Record<string, Album[]>, options: ReplaceArtistPlaylistsOptions = {}): void {
    const preservePlatforms = new Set(options.preservePlatforms || [])
    const tx = this.db.transaction(() => {
      const platformSongRows = new Map<string, Array<{ songId: string; song: Song }>>()
      for (const platform of Object.keys(PLATFORM_LABELS)) {
        const playlistId = stableId('playlist', artistName, platform)
        const existingRows = preservePlatforms.has(platform as Platform)
          ? this.listPlaylistSongs(playlistId).map((row) => ({ songId: row.id, song: row.song }))
          : []
        const incomingAlbums = platformAlbums[platform] || []
        const preserveExisting = existingRows.length > 0 && countAlbumGroups(existingRows.map((row) => row.song)) > incomingAlbums.length
        this.upsertPlaylist({
          id: playlistId,
          name: `${artistName} - ${PLATFORM_LABELS[platform]}`,
          kind: 'platform',
          artistName,
          platform,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        if (preserveExisting) {
          platformSongRows.set(platform, existingRows)
          continue
        }
        const rows: Array<{ songId: string; song: Song }> = []
        for (const album of incomingAlbums) {
          this.upsertAlbum(album)
          for (const song of album.songs) {
            const normalizedSong: Song = {
              ...song,
              albumId: song.albumId || album.id,
              albumName: song.albumName || album.name,
              coverUrl: song.coverUrl || album.coverUrl,
              raw: {
                ...(song.raw || {}),
                publishDate: song.raw.publishDate || album.publishDate,
                albumSongCount: song.raw.albumSongCount || album.songCount || album.songs.length,
              },
            }
            const songId = this.upsertSong(normalizedSong)
            rows.push({ songId, song: normalizedSong })
          }
        }
        platformSongRows.set(platform, rows)
        this.replacePlaylistSongs(playlistId, rows.map(({ songId, song }) => ({
          songId,
          candidateSources: [{ platform: song.platform, songId: song.platformSongId, qualitys: song.qualitys, song }],
        })))
      }

      const totalPlaylistId = stableId('playlist', artistName, 'total')
      this.upsertPlaylist({
        id: totalPlaylistId,
        name: `${artistName} - 总歌单`,
        kind: 'total',
        artistName,
        platform: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const totalRows: Array<{ songId: string; song: Song; candidates: unknown[] }> = []
      for (const platform of TOTAL_DOWNLOAD_CANDIDATE_PLATFORMS) {
        for (const { songId, song } of platformSongRows.get(platform) || []) {
          const match = totalRows.find((item) => sameSong(item.song, song))
          const candidate = { platform: song.platform, songId: song.platformSongId, qualitys: song.qualitys, song }
          if (match) match.candidates.push(candidate)
          else if (TOTAL_PRIMARY_PLATFORMS.includes(platform)) totalRows.push({ songId, song, candidates: [candidate] })
        }
      }
      this.replacePlaylistSongs(totalPlaylistId, totalRows.map((row) => ({ songId: row.songId, candidateSources: row.candidates })))
    })
    tx()
  }

  listPlaylists(): Playlist[] {
    return this.db.prepare('SELECT * FROM playlists ORDER BY updated_at DESC, name').all().map((row: any) => this.rowToPlaylist(row))
  }

  getPlaylist(id: string): Playlist | null {
    const row = this.db.prepare('SELECT * FROM playlists WHERE id=?').get(id) as any
    return row ? this.rowToPlaylist(row) : null
  }

  deletePlaylist(id: string): void {
    const tx = this.db.transaction((playlistId: string) => {
      this.db.prepare('DELETE FROM playlist_songs WHERE playlist_id=?').run(playlistId)
      this.db.prepare('DELETE FROM playlists WHERE id=?').run(playlistId)
      this.db.prepare('DELETE FROM download_tasks WHERE playlist_id=?').run(playlistId)
    })
    tx(id)
  }

  deleteArtistPlaylists(artistName: string): void {
    const tx = this.db.transaction((name: string) => {
      this.db.prepare('DELETE FROM download_tasks WHERE playlist_id IN (SELECT id FROM playlists WHERE artist_name=?)').run(name)
      this.db.prepare('DELETE FROM playlist_songs WHERE playlist_id IN (SELECT id FROM playlists WHERE artist_name=?)').run(name)
      this.db.prepare('DELETE FROM playlists WHERE artist_name=?').run(name)
    })
    tx(artistName)
  }

  removeSongsFromPlaylist(playlistId: string, songIds: string[]): void {
    const stmt = this.db.prepare('DELETE FROM playlist_songs WHERE playlist_id=? AND song_id=?')
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(playlistId, id)
    })
    tx(songIds)
  }

  listPlaylistSongs(playlistId: string): PlaylistSongRow[] {
    return this.db.prepare(`
      SELECT ps.song_id AS playlist_song_id, ps.position, ps.candidate_sources_json, s.*
      FROM playlist_songs ps
      JOIN songs s ON s.id = ps.song_id
      WHERE ps.playlist_id=?
      ORDER BY ps.position
    `).all(playlistId).map((row: any) => ({
      id: row.playlist_song_id,
      position: row.position,
      candidateSources: JSON.parse(row.candidate_sources_json || '[]'),
      song: rowToSong(row),
    }))
  }

  createDownloadTask(playlistId: string, playlistArtistName: string, song: Song, quality: Quality): string {
    const id = stableId('download', playlistId, song.id, song.platform, quality)
    const now = Date.now()
    const existing = this.db.prepare('SELECT status, file_path FROM download_tasks WHERE id=?').get(id) as { status: DownloadStatus; file_path: string } | undefined
    if (existing?.status === 'success' && !isReusableDownloadedAudioFile(existing.file_path, extForQuality(quality))) {
      if (existing.file_path) fs.rmSync(existing.file_path, { force: true })
      this.db.prepare('DELETE FROM download_tasks WHERE id=?').run(id)
    }
    this.db.prepare(`
      INSERT INTO download_tasks
      (id, playlist_id, playlist_artist_name, song_json, quality, status, status_text, speed, downloaded, total, file_path, error, created_at, updated_at)
      VALUES (@id, @playlistId, @playlistArtistName, @songJson, @quality, 'waiting', '等待下载', '', 0, 0, '', '', @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        playlist_artist_name=excluded.playlist_artist_name,
        song_json=excluded.song_json,
        quality=excluded.quality,
        status=CASE WHEN download_tasks.status='success' THEN download_tasks.status ELSE 'waiting' END,
        status_text='等待下载',
        speed=CASE WHEN download_tasks.status='success' THEN download_tasks.speed ELSE '' END,
        downloaded=CASE WHEN download_tasks.status='success' THEN download_tasks.downloaded ELSE 0 END,
        total=CASE WHEN download_tasks.status='success' THEN download_tasks.total ELSE 0 END,
        file_path=CASE WHEN download_tasks.status='success' THEN download_tasks.file_path ELSE '' END,
        error=CASE WHEN download_tasks.status='success' THEN download_tasks.error ELSE '' END,
        updated_at=excluded.updated_at
    `).run({ id, playlistId, playlistArtistName, songJson: JSON.stringify(song), quality, now })
    return id
  }

  listDownloadTasks(statuses?: DownloadStatus[]): DownloadTask[] {
    const rows = statuses?.length
      ? this.db.prepare(`SELECT * FROM download_tasks WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at, rowid`).all(...statuses)
      : this.db.prepare('SELECT * FROM download_tasks ORDER BY created_at, rowid').all()
    return rows.map((row: any) => ({
      id: row.id,
      playlistId: row.playlist_id,
      playlistArtistName: row.playlist_artist_name,
      song: JSON.parse(row.song_json),
      quality: row.quality,
      status: row.status,
      statusText: row.status_text,
      speed: row.speed,
      downloaded: row.downloaded,
      total: row.total,
      filePath: row.file_path,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  updateDownloadTask(id: string, updates: Partial<DownloadTask>): void {
    const allowed: Record<string, string> = {
      status: 'status',
      statusText: 'status_text',
      speed: 'speed',
      downloaded: 'downloaded',
      total: 'total',
      filePath: 'file_path',
      error: 'error',
    }
    const entries = Object.entries(updates).filter(([key]) => key in allowed)
    if (!entries.length) return
    const setSql = entries.map(([key]) => `${allowed[key]}=@${key}`).join(', ')
    this.db.prepare(`UPDATE download_tasks SET ${setSql}, updated_at=@updatedAt WHERE id=@id`).run({ ...updates, id, updatedAt: Date.now() })
  }

  removeDownloadTasks(ids: string[]): void {
    const stmt = this.db.prepare('DELETE FROM download_tasks WHERE id=?')
    const tx = this.db.transaction((taskIds: string[]) => {
      for (const id of taskIds) stmt.run(id)
    })
    tx(ids)
  }

  removeAllDownloadTasks(): void {
    this.db.prepare('DELETE FROM download_tasks').run()
  }

  resetDownloadTasks(ids: string[]): void {
    const stmt = this.db.prepare(`
      UPDATE download_tasks
      SET status='waiting', status_text='等待下载', speed='', downloaded=0, total=0, error='', updated_at=?
      WHERE id=? AND status IN ('waiting', 'failed', 'skipped', 'cancelled')
    `)
    const now = Date.now()
    const tx = this.db.transaction((taskIds: string[]) => {
      for (const id of taskIds) stmt.run(now, id)
    })
    tx(ids)
  }

  resetRetryableDownloadTasks(): void {
    this.db.prepare(`
      UPDATE download_tasks
      SET status='waiting', status_text='等待下载', speed='', downloaded=0, total=0, error='', updated_at=?
      WHERE status IN ('failed', 'skipped', 'cancelled')
    `).run(Date.now())
  }

  pauseActiveDownloadTasks(): void {
    this.db.prepare(`
      UPDATE download_tasks
      SET status='cancelled', status_text='已暂停', speed='', updated_at=?
      WHERE status IN ('waiting', 'running')
    `).run(Date.now())
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  getSetting(key: string, fallback = ''): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
    return row?.value ?? fallback
  }

  saveMusicSource(info: { name: string; script: string; enabled: boolean; sources: Record<string, unknown> }): string {
    const id = stableId('source', info.name, info.script)
    const now = Date.now()
    if (info.enabled) this.db.prepare('UPDATE music_sources SET enabled=0').run()
    this.db.prepare(`
      INSERT INTO music_sources (id, name, script, enabled, sources_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, script=excluded.script, enabled=excluded.enabled, sources_json=excluded.sources_json, updated_at=excluded.updated_at
    `).run(id, info.name, info.script, info.enabled ? 1 : 0, JSON.stringify(info.sources), now, now)
    return id
  }

  listMusicSources(): MusicSourceRecord[] {
    return this.db.prepare('SELECT * FROM music_sources ORDER BY updated_at DESC').all().map((row: any) => ({
      id: row.id,
      name: row.name,
      script: row.script,
      enabled: !!row.enabled,
      sources: JSON.parse(row.sources_json || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  getEnabledMusicSource(): MusicSourceRecord | null {
    const row = this.db.prepare('SELECT * FROM music_sources WHERE enabled=1 ORDER BY updated_at DESC LIMIT 1').get() as any
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      script: row.script,
      enabled: true,
      sources: JSON.parse(row.sources_json || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  enableMusicSource(id: string): void {
    const tx = this.db.transaction((sourceId: string) => {
      const exists = this.db.prepare('SELECT 1 FROM music_sources WHERE id=?').get(sourceId)
      if (!exists) throw new Error('音乐源不存在')
      this.db.prepare('UPDATE music_sources SET enabled=0').run()
      const result = this.db.prepare('UPDATE music_sources SET enabled=1 WHERE id=?').run(sourceId)
      if (result.changes !== 1) throw new Error('音乐源启用失败')
    })
    tx(id)
  }

  deleteMusicSource(id: string): void {
    this.db.prepare('DELETE FROM music_sources WHERE id=?').run(id)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        platform TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_album_id TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        name TEXT NOT NULL,
        publish_date TEXT,
        song_count INTEGER NOT NULL,
        cover_url TEXT,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_song_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album_id TEXT,
        album_name TEXT NOT NULL,
        duration INTEGER NOT NULL,
        track_no INTEGER NOT NULL,
        cover_url TEXT,
        qualitys_json TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playlist_songs (
        playlist_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        candidate_sources_json TEXT NOT NULL,
        PRIMARY KEY (playlist_id, song_id)
      );
      CREATE TABLE IF NOT EXISTS download_tasks (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL,
        playlist_artist_name TEXT NOT NULL,
        song_json TEXT NOT NULL,
        quality TEXT NOT NULL,
        status TEXT NOT NULL,
        status_text TEXT NOT NULL,
        speed TEXT NOT NULL,
        downloaded INTEGER NOT NULL,
        total INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        error TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS music_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        script TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        sources_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lyric_cache (
        song_id TEXT PRIMARY KEY,
        lyric_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS music_url_cache (
        song_id TEXT NOT NULL,
        quality TEXT NOT NULL,
        url TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (song_id, quality)
      );
    `)
  }

  private rowToPlaylist(row: any): Playlist {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      artistName: row.artist_name,
      platform: row.platform,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private upsertPlaylist(playlist: Playlist): void {
    this.db.prepare(`
      INSERT INTO playlists (id, name, kind, artist_name, platform, created_at, updated_at)
      VALUES (@id, @name, @kind, @artistName, @platform, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, artist_name=excluded.artist_name, platform=excluded.platform, updated_at=excluded.updated_at
    `).run(playlist)
  }

  private upsertAlbum(album: Album): void {
    this.db.prepare(`
      INSERT INTO albums (id, platform, platform_album_id, artist_name, name, publish_date, song_count, cover_url, raw_json)
      VALUES (@id, @platform, @platformAlbumId, @artistName, @name, @publishDate, @songCount, @coverUrl, @rawJson)
      ON CONFLICT(id) DO UPDATE SET artist_name=excluded.artist_name, name=excluded.name, publish_date=excluded.publish_date, song_count=excluded.song_count, cover_url=excluded.cover_url, raw_json=excluded.raw_json
    `).run({ ...album, coverUrl: album.coverUrl || '', rawJson: JSON.stringify(album.raw || {}) })
  }

  private upsertSong(song: Song): string {
    this.db.prepare(`
      INSERT INTO songs (id, platform, platform_song_id, title, artist, album_id, album_name, duration, track_no, cover_url, qualitys_json, raw_json)
      VALUES (@id, @platform, @platformSongId, @title, @artist, @albumId, @albumName, @duration, @trackNo, @coverUrl, @qualitysJson, @rawJson)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, album_id=excluded.album_id, album_name=excluded.album_name, duration=excluded.duration, track_no=excluded.track_no, cover_url=excluded.cover_url, qualitys_json=excluded.qualitys_json, raw_json=excluded.raw_json
    `).run({ ...song, coverUrl: song.coverUrl || '', qualitysJson: JSON.stringify(song.qualitys || []), rawJson: JSON.stringify(song.raw || {}) })
    return song.id
  }

  private replacePlaylistSongs(playlistId: string, rows: Array<{ songId: string; candidateSources: unknown[] }>): void {
    this.db.prepare('DELETE FROM playlist_songs WHERE playlist_id=?').run(playlistId)
    const stmt = this.db.prepare('INSERT INTO playlist_songs (playlist_id, song_id, position, candidate_sources_json) VALUES (?, ?, ?, ?)')
    rows.forEach((row, index) => stmt.run(playlistId, row.songId, index + 1, JSON.stringify(row.candidateSources)))
  }
}

function stableId(...parts: unknown[]): string {
  return crypto.createHash('sha1').update(parts.map((part) => String(part ?? '')).join('\x1f')).digest('hex')
}

function countAlbumGroups(songs: Song[]): number {
  const groups = new Set<string>()
  for (const song of songs) {
    groups.add([
      song.platform,
      song.albumId,
      normalizeCompareText(song.albumName),
      String(song.raw?.publishDate || ''),
    ].join('\x1f'))
  }
  return groups.size
}

function sameSong(left: Song, right: Song): boolean {
  return normalizeCompareText(left.title) === normalizeCompareText(right.title) &&
    normalizeCompareText(left.artist) === normalizeCompareText(right.artist) &&
    normalizeCompareText(left.albumName) === normalizeCompareText(right.albumName) &&
    (!left.duration || !right.duration || Math.abs(left.duration - right.duration) <= 5)
}

function rowToSong(row: any): Song {
  return {
    id: row.id,
    platform: row.platform,
    platformSongId: row.platform_song_id,
    title: row.title,
    artist: row.artist,
    albumId: row.album_id,
    albumName: row.album_name,
    duration: row.duration,
    trackNo: row.track_no,
    coverUrl: row.cover_url,
    qualitys: JSON.parse(row.qualitys_json || '[]'),
    raw: JSON.parse(row.raw_json || '{}'),
  }
}
