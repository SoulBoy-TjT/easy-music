import path from 'node:path'
import { buildAlbumSongTreeModel } from './core/albumModel'
import { DownloadManager } from './core/downloadManager'
import { FlacConverter, type ConvertOptions, type ConvertResult, type ConvertTask } from './core/flacConverter'
import { LibraryStore } from './core/libraryStore'
import { LxSourceBridge } from './core/sourceBridge'
import { fetchArtistPlatformAlbums, searchPlatformSongs, type FetchProgress, type ProgressCallback } from './platforms'
import { PLATFORM_LABELS, type CandidateSource, type DownloadTask, type Platform, type Playlist, type PlaylistSongRow, type Quality, type Song, type UrlResolver } from './core/types'

export interface PlaylistSummary extends Playlist {
  songCount: number
  albumCount: number
}

export interface FetchAlbumsResult {
  playlists: PlaylistSummary[]
}

export interface PlaylistSongsResult {
  rows: PlaylistSongRow[]
  albums: ReturnType<typeof buildAlbumSongTreeModel>
}

const STATUS_TEXT: Record<string, string> = {
  waiting: '等待下载',
  running: '下载中',
  success: '下载成功',
  failed: '下载失败',
  skipped: '已跳过',
  cancelled: '已取消',
}

export class AppServices {
  readonly store: LibraryStore
  private downloadRunning = false
  private currentDownloadManager: DownloadManager | null = null
  private readonly flacConverter = new FlacConverter()
  private convertRunning: Promise<ConvertResult> | null = null

  constructor(userDataPath: string) {
    this.store = new LibraryStore(path.join(userDataPath, 'library.db'))
    this.ensureDefaults()
  }

  close(): void {
    this.store.close()
  }

  async fetchArtistAlbums(artistName: string, progress?: ProgressCallback): Promise<FetchAlbumsResult> {
    const name = artistName.trim()
    if (!name) throw new Error('请输入歌手名')
    const existingAlbumCounts = this.getExistingPlatformAlbumCounts(name)
    const albums = await fetchArtistPlatformAlbums(name, progress, {
      expectedAlbumCounts: existingAlbumCounts,
    })
    const preservePlatforms = this.getIncompleteFetchedPlatforms(albums, existingAlbumCounts)
    for (const platform of preservePlatforms) {
      progress?.({
        platform,
        stage: 'preserve_existing',
        message: `${PLATFORM_LABELS[platform] || platform}：本次抓取数量少于本地已有结果，已保留本地歌单`,
      })
    }
    this.store.replaceArtistPlaylists(name, albums, { preservePlatforms })
    return { playlists: this.listPlaylists() }
  }

  listPlaylists(): PlaylistSummary[] {
    return this.store.listPlaylists().map((playlist) => {
      const rows = this.store.listPlaylistSongs(playlist.id)
      const albums = buildAlbumSongTreeModel(rows, { totalPlaylist: playlist.kind === 'total' })
      return {
        ...playlist,
        songCount: rows.length,
        albumCount: albums.length,
      }
    })
  }

  private getExistingPlatformAlbumCounts(artistName: string): Partial<Record<Platform, number>> {
    const counts: Partial<Record<Platform, number>> = {}
    for (const playlist of this.store.listPlaylists()) {
      if (playlist.artistName !== artistName || playlist.kind !== 'platform' || !playlist.platform) continue
      const rows = this.store.listPlaylistSongs(playlist.id)
      counts[playlist.platform] = buildAlbumSongTreeModel(rows).length
    }
    return counts
  }

  private getIncompleteFetchedPlatforms(platformAlbums: Record<string, unknown[]>, existingCounts: Partial<Record<Platform, number>>): Platform[] {
    return (Object.keys(existingCounts) as Platform[])
      .filter((platform) => platform === 'wy')
      .filter((platform) => {
        const existing = existingCounts[platform] || 0
        const fetched = platformAlbums[platform]?.length || 0
        return existing > 0 && fetched < existing
      })
  }

  listPlaylistSongs(playlistId: string): PlaylistSongsResult {
    const playlist = this.store.getPlaylist(playlistId)
    if (!playlist) throw new Error('歌单不存在')
    const rows = this.store.listPlaylistSongs(playlistId)
    const albums = buildAlbumSongTreeModel(rows, { totalPlaylist: playlist.kind === 'total' })
    return {
      rows: orderRowsByAlbumTree(rows, albums),
      albums,
    }
  }

  deletePlaylist(playlistId: string): PlaylistSummary[] {
    this.store.deletePlaylist(playlistId)
    return this.listPlaylists()
  }

  deleteArtist(artistName: string): PlaylistSummary[] {
    this.store.deleteArtistPlaylists(artistName)
    return this.listPlaylists()
  }

  removeSongsFromPlaylist(playlistId: string, songIds: string[]): void {
    const uniqueSongIds = Array.from(new Set(songIds.filter(Boolean)))
    if (!uniqueSongIds.length) return
    const removed = this.store.removeSongsFromPlaylist(playlistId, uniqueSongIds)
    if (!removed) throw new Error('未找到可删除的歌曲，请刷新歌单后重试')
  }

  createDownloadTasks(playlistId: string, songIds: string[] = []): string[] {
    const playlist = this.store.getPlaylist(playlistId)
    if (!playlist) throw new Error('歌单不存在')
    const quality = this.getSetting('quality', 'flac24bit') as Quality
    const rows = this.getDownloadRows(playlist, songIds)
    const taskIds: string[] = []
    for (const row of rows) {
      const song = prepareDownloadSong(row)
      taskIds.push(this.store.createDownloadTask(playlist.id, playlist.artistName, song, quality))
    }
    return taskIds
  }

  private getDownloadRows(playlist: Playlist, songIds: string[]): PlaylistSongRow[] {
    const selected = new Set(songIds)
    const rows = this.store.listPlaylistSongs(playlist.id)
    const albums = buildAlbumSongTreeModel(rows, { totalPlaylist: playlist.kind === 'total' })
    const orderedRows = orderRowsByAlbumTree(rows, albums)
    if (selected.size) return orderedRows.filter((row) => selected.has(row.id) || selected.has(row.song.id))
    if (playlist.kind !== 'total') return orderedRows

    const visibleSongIds = new Set(albums.flatMap((album) => album.children.map((child) => child.songId)))
    return orderedRows.filter((row) => visibleSongIds.has(row.id))
  }

  listDownloadTasks(): DownloadTask[] {
    return this.store.listDownloadTasks().map((task) => ({
      ...task,
      statusText: STATUS_TEXT[task.status] || task.statusText,
    }))
  }

  removeDownloadTasks(ids: string[]): DownloadTask[] {
    if (ids.length) this.store.removeDownloadTasks(ids)
    return this.listDownloadTasks()
  }

  removeAllDownloadTasks(): DownloadTask[] {
    this.store.removeAllDownloadTasks()
    return this.listDownloadTasks()
  }

  startDownloads(ids: string[] = []): { started: boolean } {
    const downloadRoot = this.getSetting('downloadRoot', '').trim()
    if (!downloadRoot) throw new Error('请选择下载目录')
    if (ids.length) this.store.resetDownloadTasks(ids)
    else this.store.resetRetryableDownloadTasks()
    if (this.downloadRunning) return { started: false }
    this.downloadRunning = true
    const resolver = this.createResolver()
    const manager = new DownloadManager(
      this.store,
      resolver,
      downloadRoot,
      Number(this.getSetting('maxConcurrent', '3')) || 3,
    )
    this.currentDownloadManager = manager
    void manager.runPending(ids)
      .catch((error) => console.error(error))
      .finally(() => {
        this.downloadRunning = false
        this.currentDownloadManager = null
      })
    return { started: true }
  }

  pauseDownloads(): DownloadTask[] {
    this.currentDownloadManager?.cancel()
    this.store.pauseActiveDownloadTasks()
    return this.listDownloadTasks()
  }

  scanFlacConversions(sourceDir: string): ConvertTask[] {
    return this.flacConverter.scan(sourceDir)
  }

  listFlacConversions(): ConvertTask[] {
    return this.flacConverter.list()
  }

  getFlacConversionResult(): ConvertResult {
    return this.flacConverter.result()
  }

  startFlacConversions(options: ConvertOptions): { started: boolean } & ConvertResult {
    if (this.convertRunning) return { started: false, ...this.flacConverter.result() }
    this.convertRunning = this.flacConverter.start(options)
      .catch((error) => {
        console.error(error)
        return this.flacConverter.result()
      })
      .finally(() => {
        this.convertRunning = null
      }) as Promise<ConvertResult>
    return { started: true, ...this.flacConverter.result() }
  }

  cancelFlacConversions(): ConvertTask[] {
    return this.flacConverter.cancel()
  }

  async importSource(script: string): Promise<string> {
    const bridge = new LxSourceBridge(script)
    const info = await bridge.initialize()
    return this.store.saveMusicSource({
      name: resolveSourceName(info, script),
      script,
      enabled: true,
      sources: info.sources || {},
    })
  }

  listSources() {
    return this.store.listMusicSources().map(({ script: _script, ...source }) => source)
  }

  async testSource(id: string): Promise<{ ok: boolean; message: string }> {
    const source = this.store.listMusicSources().find((item) => item.id === id)
    if (!source) throw new Error('音乐源不存在')
    const bridge = new LxSourceBridge(source.script)
    const info = await bridge.initialize()
    return { ok: !!info.status, message: info.status ? '音乐源初始化成功' : '音乐源初始化失败' }
  }

  enableSource(id: string) {
    this.store.enableMusicSource(id)
    return this.listSources()
  }

  deleteSource(id: string) {
    this.store.deleteMusicSource(id)
    return this.listSources()
  }

  getSetting(key: string, fallback = ''): string {
    return this.store.getSetting(key, fallback)
  }

  setSetting(key: string, value: string): string {
    this.store.setSetting(key, value)
    return value
  }

  private ensureDefaults(): void {
    const defaults: Record<string, string> = {
      quality: 'flac24bit',
      maxConcurrent: '3',
      songViewMode: 'flat',
      embedCover: 'true',
      embedLyric: 'true',
    }
    for (const [key, value] of Object.entries(defaults)) {
      if (!this.store.getSetting(key)) this.store.setSetting(key, value)
    }
  }

  private createResolver(): UrlResolver {
    const source = this.store.getEnabledMusicSource()
    if (!source) return new MissingSourceResolver()
    const bridge = new LxSourceBridge(source.script)
    return {
      requestMusicUrl: bridge.requestMusicUrl.bind(bridge),
      requestLyric: bridge.requestLyric.bind(bridge),
      requestPic: bridge.requestPic.bind(bridge),
      searchSongs: (query, platforms, limit) => searchPlatformSongs(query, platforms, limit),
    }
  }
}

class MissingSourceResolver implements UrlResolver {
  async requestMusicUrl(): Promise<string> {
    throw new Error('未启用音乐源')
  }

  async requestLyric() {
    return null
  }

  async requestPic() {
    return null
  }
}

function prepareDownloadSong(row: PlaylistSongRow): Song {
  const candidates = normalizeRowCandidates(row)
  return {
    ...row.song,
    raw: {
      ...row.song.raw,
      downloadCandidates: candidates,
    },
  }
}

function orderRowsByAlbumTree(
  rows: PlaylistSongRow[],
  albums: ReturnType<typeof buildAlbumSongTreeModel>,
): PlaylistSongRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const orderedRows: PlaylistSongRow[] = []
  for (const album of albums) {
    for (const child of album.children) {
      const row = byId.get(child.songId)
      if (!row) continue
      orderedRows.push(row)
    }
  }
  return orderedRows
}

function normalizeRowCandidates(row: PlaylistSongRow): CandidateSource[] {
  const candidates = row.candidateSources?.length
    ? row.candidateSources
    : [{ platform: row.song.platform, songId: row.song.platformSongId, qualitys: row.song.qualitys, song: row.song }]
  if (candidates.some((candidate) => candidate.song.platform === row.song.platform && candidate.song.platformSongId === row.song.platformSongId)) {
    return candidates
  }
  return [{ platform: row.song.platform, songId: row.song.platformSongId, qualitys: row.song.qualitys, song: row.song }, ...candidates]
}

function resolveSourceName(info: { name?: string; sources?: Record<string, unknown> }, script: string): string {
  const directName = String(info.name || '').trim()
  if (directName) return directName
  const metadataName = readSourceMetadataName(script)
  if (metadataName) return metadataName
  const sourceNames = Object.values(info.sources || {})
    .map((source) => source && typeof source === 'object' ? String((source as { name?: unknown }).name || '').trim() : '')
    .filter(Boolean)
  if (sourceNames.length === 1) return sourceNames[0]
  if (sourceNames.length > 1) return sourceNames.join(' / ')
  if (/ikun/i.test(script)) return 'ikun音乐源'
  return `自定义音乐源 ${shortScriptId(script)}`
}

function readSourceMetadataName(script: string): string {
  const match = script.match(/@name\s+([^\r\n]+)/)
  return match?.[1]?.trim() || ''
}

function shortScriptId(script: string): string {
  let hash = 0
  for (let index = 0; index < script.length; index += 1) {
    hash = ((hash << 5) - hash + script.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36).slice(0, 6)
}

export type { FetchProgress }
