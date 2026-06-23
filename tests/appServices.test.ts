import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppServices } from '../src/main/appServices'
import type { Album, Song } from '../src/main/core/types'

describe('app services download task creation', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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
    id: `${platform}:${trackNo}`,
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
