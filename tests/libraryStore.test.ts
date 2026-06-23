import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryStore } from '../src/main/core/libraryStore'
import type { Album } from '../src/main/core/types'

const FLAC_BYTES = Buffer.from('fLaCminimal-audio-data')

describe('library store', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('persists artist playlists, songs, sources, settings and download tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'library.db')
    const album: Album = {
      id: 'kg:a1',
      platform: 'kg',
      platformAlbumId: 'a1',
      artistName: 'Singer',
      name: 'Album',
      publishDate: '2024-01-01',
      songCount: 1,
      coverUrl: 'https://example.test/a.jpg',
      raw: {},
      songs: [{
        id: 'kg:s1',
        platform: 'kg',
        platformSongId: 's1',
        title: 'Song',
        artist: 'Singer',
        albumId: 'kg:a1',
        albumName: 'Album',
        duration: 180,
        trackNo: 1,
        coverUrl: 'https://example.test/a.jpg',
        qualitys: ['flac'],
        raw: { publishDate: '2024-01-01', albumSongCount: 1 },
      }],
    }

    const store = new LibraryStore(dbPath)
    store.replaceArtistPlaylists('Singer', { kw: [], kg: [album], tx: [], wy: [] })
    store.setSetting('downloadRoot', 'D:/Music')
    const sourceId = store.saveMusicSource({ name: 'Source', script: 'script', enabled: true, sources: { kw: {} } })
    const total = store.listPlaylists().find((playlist) => playlist.kind === 'total')!
    const [songRow] = store.listPlaylistSongs(total.id)
    const taskId = store.createDownloadTask(total.id, total.artistName, songRow.song, 'flac')
    store.updateDownloadTask(taskId, { status: 'success', filePath: 'D:/Music/Song.flac' })
    store.close()

    const reopened = new LibraryStore(dbPath)
    expect(reopened.getSetting('downloadRoot')).toBe('D:/Music')
    expect(reopened.listMusicSources()[0].id).toBe(sourceId)
    expect(reopened.listPlaylists().map((playlist) => playlist.name)).toContain('Singer - 总歌单')
    expect(reopened.listPlaylistSongs(total.id)[0].song.title).toBe('Song')
    expect(reopened.listDownloadTasks()[0]).toMatchObject({ status: 'success', filePath: 'D:/Music/Song.flac' })
    reopened.close()
  })

  it('deletes every playlist and download task for an artist only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    const firstAlbum = makeAlbum('First Artist', 'first-song')
    const secondAlbum = makeAlbum('Second Artist', 'second-song')

    store.replaceArtistPlaylists('First Artist', { kw: [], kg: [firstAlbum], tx: [], wy: [] })
    store.replaceArtistPlaylists('Second Artist', { kw: [], kg: [secondAlbum], tx: [], wy: [] })
    const firstTotal = store.listPlaylists().find((playlist) => playlist.artistName === 'First Artist' && playlist.kind === 'total')!
    const [firstSong] = store.listPlaylistSongs(firstTotal.id)
    store.createDownloadTask(firstTotal.id, firstTotal.artistName, firstSong.song, 'flac')

    store.deleteArtistPlaylists('First Artist')

    expect(store.listPlaylists().filter((playlist) => playlist.artistName === 'First Artist')).toEqual([])
    expect(store.listPlaylists().filter((playlist) => playlist.artistName === 'Second Artist')).toHaveLength(5)
    expect(store.listDownloadTasks()).toEqual([])
    store.close()
  })

  it('keeps Kuwo platform playlist and uses Kuwo only as the last total download fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))

    store.replaceArtistPlaylists('Singer', {
      kw: [makePlatformAlbum('kw', 'kw-song'), makePlatformAlbum('kw', 'kw-unique', 'Kuwo Unique')],
      kg: [makePlatformAlbum('kg', 'kg-song')],
      tx: [makePlatformAlbum('tx', 'tx-song')],
      wy: [makePlatformAlbum('wy', 'wy-song')],
    })

    const playlists = store.listPlaylists()
    const kuwo = playlists.find((playlist) => playlist.platform === 'kw')!
    const total = playlists.find((playlist) => playlist.kind === 'total')!
    const totalRows = store.listPlaylistSongs(total.id)

    expect(store.listPlaylistSongs(kuwo.id)).toHaveLength(2)
    expect(totalRows).toHaveLength(1)
    expect(totalRows[0].song.platform).toBe('kg')
    expect(totalRows[0].candidateSources.map((candidate) => candidate.platform)).toEqual(['kg', 'tx', 'wy', 'kw'])
    store.close()
  })

  it('keeps an existing platform playlist when a new fetch for that platform is incomplete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    try {
      store.replaceArtistPlaylists('Singer', {
        kw: [],
        kg: [],
        tx: [],
        wy: [
          makeDistinctPlatformAlbum('wy', 'wy-first', 'First Album', 'First'),
          makeDistinctPlatformAlbum('wy', 'wy-second', 'Second Album', 'Second'),
        ],
      })
      store.replaceArtistPlaylists('Singer', {
        kw: [],
        kg: [],
        tx: [],
        wy: [makeDistinctPlatformAlbum('wy', 'wy-first', 'First Album', 'First')],
      }, { preservePlatforms: ['wy'] })

      const netease = store.listPlaylists().find((playlist) => playlist.platform === 'wy')!
      const total = store.listPlaylists().find((playlist) => playlist.kind === 'total')!

      expect(store.listPlaylistSongs(netease.id).map((row) => row.song.title)).toEqual(['First', 'Second'])
      expect(store.listPlaylistSongs(total.id).map((row) => row.song.title)).toEqual(['First', 'Second'])
    } finally {
      store.close()
    }
  })

  it('creates independent download tasks for different selected platforms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    const kgSong = makePlatformAlbum('kg', 'kg-song').songs[0]
    const txSong = makePlatformAlbum('tx', 'tx-song').songs[0]

    const kgTaskId = store.createDownloadTask('playlist-1', 'Singer', {
      ...kgSong,
      raw: { ...kgSong.raw, downloadCandidates: [{ platform: 'kg', songId: kgSong.platformSongId, qualitys: kgSong.qualitys, song: kgSong }] },
    }, 'flac')
    const txTaskId = store.createDownloadTask('playlist-1', 'Singer', {
      ...txSong,
      raw: { ...txSong.raw, downloadCandidates: [{ platform: 'tx', songId: txSong.platformSongId, qualitys: txSong.qualitys, song: txSong }] },
    }, 'flac')

    expect(kgTaskId).not.toBe(txTaskId)
    expect(store.listDownloadTasks().map((task) => task.song.platform).sort()).toEqual(['kg', 'tx'])
    store.close()
  })

  it('keeps successful download tasks successful when download all queues the same task again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    const song = makePlatformAlbum('kg', 'kg-song').songs[0]
    const filePath = join(dir, 'downloads', 'Song.flac')
    mkdirSync(join(dir, 'downloads'), { recursive: true })
    writeFileSync(filePath, FLAC_BYTES)

    const taskId = store.createDownloadTask('playlist-1', 'Singer', song, 'flac')
    store.updateDownloadTask(taskId, { status: 'success', filePath, downloaded: 100, total: 100 })
    const queuedAgainId = store.createDownloadTask('playlist-1', 'Singer', song, 'flac')

    expect(queuedAgainId).toBe(taskId)
    expect(store.listDownloadTasks()[0]).toMatchObject({
      status: 'success',
      filePath,
      downloaded: 100,
      total: 100,
    })
    store.close()
  })

  it('lists download tasks in creation order for front-to-back display', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    const firstSong = makePlatformAlbum('kg', 'first', 'First').songs[0]
    const secondSong = makePlatformAlbum('kg', 'second', 'Second').songs[0]

    store.createDownloadTask('playlist-1', 'Singer', firstSong, 'flac')
    store.createDownloadTask('playlist-1', 'Singer', secondSong, 'flac')

    expect(store.listDownloadTasks().map((task) => task.song.title)).toEqual(['First', 'Second'])
    store.close()
  })

  it('pauses waiting and running download tasks so they can be resumed later', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    const waitingId = store.createDownloadTask('playlist-1', 'Singer', makePlatformAlbum('kg', 'waiting', 'Waiting').songs[0], 'flac')
    const runningId = store.createDownloadTask('playlist-1', 'Singer', makePlatformAlbum('kg', 'running', 'Running').songs[0], 'flac')
    const successId = store.createDownloadTask('playlist-1', 'Singer', makePlatformAlbum('kg', 'success', 'Success').songs[0], 'flac')
    store.updateDownloadTask(runningId, { status: 'running', statusText: '下载中' })
    store.updateDownloadTask(successId, { status: 'success', statusText: '下载成功' })

    store.pauseActiveDownloadTasks()

    const byId = new Map(store.listDownloadTasks().map((task) => [task.id, task]))
    expect(byId.get(waitingId)).toMatchObject({ status: 'cancelled', statusText: '已暂停', speed: '' })
    expect(byId.get(runningId)).toMatchObject({ status: 'cancelled', statusText: '已暂停', speed: '' })
    expect(byId.get(successId)).toMatchObject({ status: 'success' })
    store.resetRetryableDownloadTasks()
    expect(store.listDownloadTasks().find((task) => task.id === waitingId)?.status).toBe('waiting')
    store.close()
  })

  it('refreshes candidates and clears stale file state when a failed task is queued again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    const kgSong = makePlatformAlbum('kg', 'kg-song').songs[0]
    const txSong = makePlatformAlbum('tx', 'tx-song').songs[0]

    const taskId = store.createDownloadTask('playlist-1', 'Singer', {
      ...kgSong,
      raw: { ...kgSong.raw, downloadCandidates: [{ platform: 'kg', songId: kgSong.platformSongId, qualitys: kgSong.qualitys, song: kgSong }] },
    }, 'flac')
    store.updateDownloadTask(taskId, {
      status: 'failed',
      filePath: join(dir, 'downloads', 'bad.mp3'),
      downloaded: 123,
      total: 123,
      error: 'old error',
    })

    store.createDownloadTask('playlist-1', 'Singer', {
      ...kgSong,
      raw: {
        ...kgSong.raw,
        downloadCandidates: [
          { platform: 'kg', songId: kgSong.platformSongId, qualitys: kgSong.qualitys, song: kgSong },
          { platform: 'tx', songId: txSong.platformSongId, qualitys: txSong.qualitys, song: txSong },
        ],
      },
    }, 'flac')

    const [task] = store.listDownloadTasks()
    expect(task.status).toBe('waiting')
    expect(task.filePath).toBe('')
    expect(task.downloaded).toBe(0)
    expect(task.total).toBe(0)
    expect((task.song.raw.downloadCandidates as any[]).map((candidate) => candidate.platform)).toEqual(['kg', 'tx'])
    store.close()
  })

  it('enables the selected music source and keeps existing source enabled if target is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    const firstId = store.saveMusicSource({ name: 'First', script: 'first', enabled: true, sources: { kg: {} } })
    const secondId = store.saveMusicSource({ name: 'Second', script: 'second', enabled: false, sources: { tx: {} } })

    store.enableMusicSource(secondId)
    expect(store.getEnabledMusicSource()?.id).toBe(secondId)
    expect(store.listMusicSources().filter((source) => source.enabled)).toHaveLength(1)

    expect(() => store.enableMusicSource('missing-source')).toThrow('音乐源不存在')
    expect(store.getEnabledMusicSource()?.id).toBe(secondId)
    expect(store.listMusicSources().find((source) => source.id === firstId)?.enabled).toBe(false)
    store.close()
  })

  it('does not reorder music sources when enabling an existing source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-store-'))
    tempDirs.push(dir)
    const store = new LibraryStore(join(dir, 'library.db'))
    const firstId = store.saveMusicSource({ name: 'First', script: 'first', enabled: true, sources: { kg: {} } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const secondId = store.saveMusicSource({ name: 'Second', script: 'second', enabled: true, sources: { tx: {} } })
    const before = store.listMusicSources().map((source) => source.id)

    store.enableMusicSource(firstId)

    expect(store.getEnabledMusicSource()?.id).toBe(firstId)
    expect(store.listMusicSources().map((source) => source.id)).toEqual(before)
    expect(before).toEqual([secondId, firstId])
    store.close()
  })
})

function makeAlbum(artistName: string, songId: string): Album {
  return {
    id: `kg:${artistName}`,
    platform: 'kg',
    platformAlbumId: artistName,
    artistName,
    name: 'Album',
    publishDate: '2024-01-01',
    songCount: 1,
    coverUrl: '',
    raw: {},
    songs: [{
      id: `kg:${songId}`,
      platform: 'kg',
      platformSongId: songId,
      title: 'Song',
      artist: artistName,
      albumId: `kg:${artistName}`,
      albumName: 'Album',
      duration: 180,
      trackNo: 1,
      coverUrl: '',
      qualitys: ['flac'],
      raw: { publishDate: '2024-01-01', albumSongCount: 1 },
    }],
  }
}

function makePlatformAlbum(platform: string, songId: string, title = 'Song'): Album {
  return {
    ...makeAlbum('Singer', songId),
    id: `${platform}:album`,
    platform,
    platformAlbumId: `${platform}-album`,
    songs: [{
      ...makeAlbum('Singer', songId).songs[0],
      id: `${platform}:${songId}`,
      platform,
      platformSongId: songId,
      title,
      albumId: `${platform}:album`,
    }],
  }
}

function makeDistinctPlatformAlbum(platform: string, albumId: string, albumName: string, title: string): Album {
  const base = makePlatformAlbum(platform, `${albumId}-song`, title)
  return {
    ...base,
    id: `${platform}:${albumId}`,
    platformAlbumId: albumId,
    name: albumName,
    songs: base.songs.map((song) => ({
      ...song,
      id: `${platform}:${albumId}:song`,
      platformSongId: `${albumId}-song`,
      albumId: `${platform}:${albumId}`,
      albumName,
    })),
  }
}
