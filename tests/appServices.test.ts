import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServices } from '../src/main/appServices'
import * as windowsExplorer from '../src/main/core/windowsExplorer'
import type { Album, Song } from '../src/main/core/types'

describe('app services download task creation', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('scans and normalizes selected artist folders through the service', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    const root = join(dir, 'downloads')
    try {
      writeFolderFile(join(root, 'Singer', 'Album', '01. Song.flac'), Buffer.from('fLaCminimal-audio-data'))
      writeFolderFile(join(root, 'Singer', 'Album', 'cover.jpg'), 'cover')
      const closeSpy = vi.spyOn(windowsExplorer, 'closeExplorerWindowsForPaths')
        .mockReturnValue({ closedPaths: [join(root, 'Singer')], errors: [] })

      const scanned = service.scanArtistFolders(root)
      const normalized = service.normalizeArtistFolders(root, ['Singer'])

      expect(scanned.items.map((item) => item.name)).toEqual(['Singer'])
      expect(closeSpy).toHaveBeenNthCalledWith(1, [join(root, 'Singer')], { exactPaths: [root] })
      expect(closeSpy).toHaveBeenNthCalledWith(2, [join(root, 'Singer', 'Album (1首)')], { exactPaths: [join(root, 'Singer')] })
      expect(normalized.closedExplorerWindows).toEqual([join(root, 'Singer')])
      expect(normalized.items[0]).toMatchObject({ originalName: 'Singer', songCount: 1, renamed: true })
      expect(existsSync(join(root, 'Singer'))).toBe(false)
      expect(existsSync(normalized.items[0].path)).toBe(true)
    } finally {
      service.close()
    }
  })

  it('queues only visible deduped album songs when downloading all from the total playlist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      service.store.replaceArtistPlaylists('Singer', {
        kw: [],
        kg: [album('kg', '2024-07-10', ['A', 'B', 'C'], 'Live Part')],
        tx: [album('tx', '2024-07-10', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 'Live Full')],
        wy: [],
      })
      const total = service.listPlaylists().find((playlist) => playlist.kind === 'total')!

      const taskIds = service.createDownloadTasks(total.id, [])
      const tasks = service.store.listDownloadTasks()

      expect(taskIds).toHaveLength(8)
      expect(tasks).toHaveLength(8)
      expect(new Set(tasks.map((task) => task.song.platform))).toEqual(new Set(['tx']))
    } finally {
      service.close()
    }
  })

  it('keeps balanced matched hidden albums available for merge audit while listing only visible songs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      service.store.replaceArtistPlaylists('Singer', {
        kw: [],
        kg: [album('kg', '2024-07-10', ['Intro Live', 'Blue Live', 'Home Live'], 'World Tour Live EP')],
        tx: [album('tx', '2024-07-10', ['Intro', 'Blue', 'Home', 'Rain', 'Night', 'Fire', 'River', 'Encore'], 'World Tour Live')],
        wy: [],
      })
      const total = service.listPlaylists().find((playlist) => playlist.kind === 'total')!

      const result = service.listPlaylistSongs(total.id)

      expect(result.rows).toHaveLength(8)
      expect(result.rows.every((row) => row.song.platform === 'tx')).toBe(true)
      expect(result.albums).toHaveLength(1)
      expect(result.albums[0].mergedAlbums).toHaveLength(1)
      expect(result.albums[0].mergedAlbums[0]).toMatchObject({
        albumName: 'World Tour Live EP',
        platform: 'kg',
        songs: ['01. Intro Live', '02. Blue Live', '03. Home Live'],
      })
    } finally {
      service.close()
    }
  })

  it('merges cross-date total playlist album variants before listing visible songs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      const titles = [
        '爱投罗网',
        '爱骗我',
        '未完的承诺',
        '惜命命',
        '狮子吼',
        '第61分钟',
        '爱我喊出来',
        '爱惨了',
        '想逃',
        '如果还有如果',
        '舞魂再现',
        '我的皇后',
        '占爱为王',
        '爱投罗网 Remix',
        '爱我喊出来 Remix',
        '第61分钟 Remix',
      ]
      service.store.replaceArtistPlaylists('Singer', {
        kw: [],
        kg: [album('kg', '2013-10-16', titles, '狮子吼')],
        tx: [album('tx', '2013-12-06', titles, '狮子吼之舞魂再现 冠军ENCORE版')],
        wy: [],
      })
      const total = service.listPlaylists().find((playlist) => playlist.kind === 'total')!

      const result = service.listPlaylistSongs(total.id)

      expect(result.rows).toHaveLength(16)
      expect(result.rows.every((row) => row.song.platform === 'kg')).toBe(true)
      expect(result.albums).toHaveLength(1)
      expect(result.albums[0].mergedAlbums).toHaveLength(1)
      expect(result.albums[0].mergedAlbums[0]).toMatchObject({
        albumName: '狮子吼之舞魂再现 冠军ENCORE版',
        publishDate: '2013-12-06',
        platform: 'tx',
        songCount: 16,
      })
    } finally {
      service.close()
    }
  })

  it('lists songs in the same order as the album tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      service.store.replaceArtistPlaylists('Singer', {
        kw: [
          album('kw', '2024-02-01', ['Second'], 'Later Album'),
          album('kw', '2024-01-01', ['First B', 'First A'], 'Earlier Album'),
        ],
        kg: [],
        tx: [],
        wy: [],
      })
      const kuwo = service.listPlaylists().find((playlist) => playlist.platform === 'kw')!

      const result = service.listPlaylistSongs(kuwo.id)
      const albumSongIds = result.albums.flatMap((albumNode) => albumNode.children.map((child) => child.songId))

      expect(result.albums.map((albumNode) => albumNode.albumName)).toEqual(['Earlier Album', 'Later Album'])
      expect(result.rows.map((row) => row.id)).toEqual(albumSongIds)
      expect(result.rows.map((row) => row.song.title)).toEqual(['First B', 'First A', 'Second'])
    } finally {
      service.close()
    }
  })

  it('does not append hidden deduped total-playlist songs to the flat list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      service.store.replaceArtistPlaylists('Singer', {
        kw: [],
        kg: [album('kg', '2024-07-10', ['A', 'B'], 'Live Part')],
        tx: [album('tx', '2024-07-10', ['A', 'B', 'C'], 'Live Full')],
        wy: [],
      })
      const total = service.listPlaylists().find((playlist) => playlist.kind === 'total')!

      const result = service.listPlaylistSongs(total.id)
      const updatedTotal = service.listPlaylists().find((playlist) => playlist.id === total.id)!
      const albumSongIds = result.albums.flatMap((albumNode) => albumNode.children.map((child) => child.songId))

      expect(updatedTotal.songCount).toBe(result.rows.length)
      expect(result.rows.map((row) => row.id)).toEqual(albumSongIds)
      expect(result.rows.map((row) => row.song.title)).toEqual(['A', 'B', 'C'])
      expect(result.rows.every((row) => row.song.platform === 'tx')).toBe(true)
    } finally {
      service.close()
    }
  })

  it('uses flac24bit as the default download quality for new settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      service.store.replaceArtistPlaylists('Singer', {
        kw: [album('kw', '2024-01-01', ['Song'])],
        kg: [],
        tx: [],
        wy: [],
      })
      const kuwo = service.listPlaylists().find((playlist) => playlist.platform === 'kw')!

      service.createDownloadTasks(kuwo.id, [])

      expect(service.store.listDownloadTasks().map((task) => task.quality)).toEqual(['flac24bit'])
    } finally {
      service.close()
    }
  })

  it('queues selected songs in album tree order instead of selection order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      service.store.replaceArtistPlaylists('Singer', {
        kw: [
          album('kw', '2024-02-01', ['Later'], 'Later Album'),
          album('kw', '2024-01-01', ['Earlier B', 'Earlier A'], 'Earlier Album'),
        ],
        kg: [],
        tx: [],
        wy: [],
      })
      const kuwo = service.listPlaylists().find((playlist) => playlist.platform === 'kw')!
      const result = service.listPlaylistSongs(kuwo.id)
      const selectedIds = [...result.rows].reverse().map((row) => row.id)

      service.createDownloadTasks(kuwo.id, selectedIds)

      expect(service.store.listDownloadTasks().map((task) => task.song.title)).toEqual(['Earlier B', 'Earlier A', 'Later'])
    } finally {
      service.close()
    }
  })

  it('updates playlist song and album counts after removing songs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      service.store.replaceArtistPlaylists('Singer', {
        kw: [
          album('kw', '2024-02-01', ['Later'], 'Later Album'),
          album('kw', '2024-01-01', ['Earlier B', 'Earlier A'], 'Earlier Album'),
        ],
        kg: [],
        tx: [],
        wy: [],
      })
      const kuwo = service.listPlaylists().find((playlist) => playlist.platform === 'kw')!
      const initial = service.listPlaylists().find((playlist) => playlist.id === kuwo.id)!
      const earlierSongIds = service.listPlaylistSongs(kuwo.id)
        .rows
        .filter((row) => row.song.albumName === 'Earlier Album')
        .map((row) => row.id)

      service.removeSongsFromPlaylist(kuwo.id, earlierSongIds)

      const updated = service.listPlaylists().find((playlist) => playlist.id === kuwo.id)!
      expect(initial).toMatchObject({ songCount: 3, albumCount: 2 })
      expect(updated).toMatchObject({ songCount: 1, albumCount: 1 })
    } finally {
      service.close()
    }
  })

  it('keeps the default download directory empty until the user chooses one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      expect(service.getSetting('downloadRoot')).toBe('')
      expect(() => service.startDownloads()).toThrow('请选择下载目录')
    } finally {
      service.close()
    }
  })

  it('infers a readable source name for LX scripts without init name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      await service.importSource(`
        const EVENT_NAMES = globalThis.lx.EVENT_NAMES
        const send = globalThis.lx.send
        globalThis.lx.on(EVENT_NAMES.request, () => null)
        send(EVENT_NAMES.inited, {
          status: true,
          sources: { kg: { name: '小狗音乐', actions: ['musicUrl'], qualitys: ['flac'] } }
        })
      `)

      expect(service.listSources()[0].name).toBe('小狗音乐')
    } finally {
      service.close()
    }
  })

  it('uses LX metadata comment name before platform source names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-service-'))
    tempDirs.push(dir)
    const service = new AppServices(dir)
    try {
      await service.importSource(`
        /*!
         * @name ikun音源[赞助][永久]
         */
        const EVENT_NAMES = globalThis.lx.EVENT_NAMES
        globalThis.lx.on(EVENT_NAMES.request, () => null)
        globalThis.lx.send(EVENT_NAMES.inited, {
          status: true,
          sources: {
            kw: { name: 'kw', actions: ['musicUrl'], qualitys: ['flac'] },
            kg: { name: 'kg', actions: ['musicUrl'], qualitys: ['flac'] }
          }
        })
      `)

      expect(service.listSources()[0].name).toBe('ikun音源[赞助][永久]')
    } finally {
      service.close()
    }
  })
})

function album(platform: string, publishDate: string, titles: string[], albumName = 'Live Album'): Album {
  return {
    id: `${platform}:live`,
    platform,
    platformAlbumId: `${platform}-live`,
    artistName: 'Singer',
    name: albumName,
    publishDate,
    songCount: titles.length,
    coverUrl: '',
    raw: {},
    songs: titles.map((title, index) => song(platform, title, publishDate, index + 1, titles.length, albumName)),
  }
}

function song(platform: string, title: string, publishDate: string, trackNo: number, albumSongCount: number, albumName: string): Song {
  return {
    id: `${platform}:${albumName}:${trackNo}`,
    platform,
    platformSongId: `${platform}-${trackNo}`,
    title,
    artist: 'Singer',
    albumId: `${platform}:live`,
    albumName,
    duration: 180,
    trackNo,
    coverUrl: '',
    qualitys: ['flac'],
    raw: { publishDate, albumSongCount },
  }
}

function writeFolderFile(filePath: string, data: string | Buffer): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, data)
}
