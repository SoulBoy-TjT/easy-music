import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadManager } from '../src/main/core/downloadManager'
import { JsonStore } from '../src/main/core/jsonStore'
import type { Song } from '../src/main/core/types'

const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x0f, 0xf0, 0x00, 0x00, 0x69, 0x00, 0x00])
const FLAC_BYTES = Buffer.from('fLaCminimal-audio-data')

describe('download manager', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('refreshes expired URL and downloads internally to playlist artist folder', async () => {
    let firstUrlHit = 0
    const server = http.createServer((req, res) => {
      if (req.url === '/expired') {
        firstUrlHit += 1
        res.statusCode = 403
        res.end('expired')
        return
      }
      if (req.url === '/ok') {
        res.setHeader('content-type', 'audio/flac')
        res.end(FLAC_BYTES)
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const song: Song = {
      id: 'kw:1',
      platform: 'kw',
      platformSongId: '1',
      title: '微光',
      artist: '华晨宇&和平精英',
      albumId: 'a1',
      albumName: '和平精英',
      duration: 180,
      trackNo: 1,
      qualitys: ['flac'],
      raw: { publishDate: '2025-01-10', albumSongCount: 1 },
    }
    store.createDownloadTask('playlist-1', '华晨宇', song, 'flac')
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (_platform, _info, _quality, refresh) => ({
        url: `http://127.0.0.1:${port}/${refresh ? 'ok' : 'expired'}`,
      }),
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(firstUrlHit).toBe(1)
    expect(task.status).toBe('success')
    expect(task.filePath).toContain("华晨宇\\2025-01-10 和平精英\\01. 微光.flac")
    expect(readFileSync(task.filePath).subarray(0, 4).toString('ascii')).toBe('fLaC')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('uses candidate source publishtime for album folder date', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end(FLAC_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const kgSong: Song = {
      id: 'kg:1',
      platform: 'kg',
      platformSongId: 'hash-1',
      title: 'Song',
      artist: 'Singer',
      albumId: 'kg:a1',
      albumName: 'Kugou Album',
      duration: 180,
      trackNo: 1,
      qualitys: ['flac'],
      raw: { publishtime: '2026-04-22 00:00:00', albumSongCount: 1 },
    }
    const totalSong: Song = {
      ...kgSong,
      id: 'total:1',
      platform: 'wy',
      platformSongId: 'wy-1',
      raw: { downloadCandidates: [{ platform: 'kg', songId: 'hash-1', qualitys: ['flac'], song: kgSong }] },
    }
    store.createDownloadTask('playlist-total', 'Singer', totalSong, 'flac')
    const manager = new DownloadManager(store, {
      requestMusicUrl: async () => ({ url: `http://127.0.0.1:${port}/ok` }),
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(task.status).toBe('success')
    expect(task.filePath).toContain("Singer\\2026-04-22 Kugou Album\\01. Song.flac")
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('stores Chinese platform download errors for source request failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    store.createDownloadTask('playlist-1', 'Singer', song('wy', 'Song'), 'flac')
    const manager = new DownloadManager(store, {
      requestMusicUrl: async () => {
        throw new Error('TypeError: request is not a function')
      },
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(task.status).toBe('failed')
    expect(task.error).toContain('网易云音乐 / 1 / flac：音乐源请求接口不兼容：缺少 request 方法')
  })

  it('stores Chinese platform download errors for HTTP status failures', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end('missing')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    store.createDownloadTask('playlist-1', 'Singer', song('kw', 'Song'), 'flac')
    const manager = new DownloadManager(store, {
      requestMusicUrl: async () => ({ url: `http://127.0.0.1:${port}/missing` }),
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(task.status).toBe('failed')
    expect(task.error).toContain('酷我音乐 / 1 / flac：下载地址不存在（404）')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('falls back to the next candidate platform when the first platform cannot provide a URL', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end(FLAC_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const kgSong = song('kg', 'Song')
    const txSong = song('tx', 'Song')
    store.createDownloadTask('playlist-1', 'Singer', {
      ...kgSong,
      raw: {
        ...kgSong.raw,
        downloadCandidates: [
          { platform: 'kg', songId: 'kg-1', qualitys: ['flac'], song: kgSong },
          { platform: 'tx', songId: 'tx-1', qualitys: ['flac'], song: txSong },
        ],
      },
    }, 'flac')
    const requestedPlatforms: string[] = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (platform) => {
        requestedPlatforms.push(String(platform))
        if (platform === 'kg') throw new Error('获取URL失败')
        return { url: `http://127.0.0.1:${port}/ok` }
      },
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(requestedPlatforms).toEqual(['kg', 'tx'])
    expect(task.status).toBe('success')
    expect(readFileSync(task.filePath).subarray(0, 4).toString('ascii')).toBe('fLaC')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('rejects invalid audio payloads and falls back to the next candidate platform', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'audio/mpeg')
      res.end(req.url === '/bad' ? 'encrypted-or-error-payload' : MP3_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const kgSong = { ...song('kg', 'Song'), qualitys: ['320k'] }
    const txSong = { ...song('tx', 'Song'), qualitys: ['320k'] }
    store.createDownloadTask('playlist-1', 'Singer', {
      ...kgSong,
      raw: {
        ...kgSong.raw,
        downloadCandidates: [
          { platform: 'kg', songId: 'kg-1', qualitys: ['320k'], song: kgSong },
          { platform: 'tx', songId: 'tx-1', qualitys: ['320k'], song: txSong },
        ],
      },
    }, 'flac')
    const requestedPlatforms: string[] = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (platform) => {
        requestedPlatforms.push(String(platform))
        return { url: `http://127.0.0.1:${port}/${platform === 'kg' ? 'bad' : 'ok'}` }
      },
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(requestedPlatforms).toEqual(['kg', 'tx'])
    expect(task.status).toBe('success')
    expect(readFileSync(task.filePath).subarray(-MP3_BYTES.length)).toEqual(MP3_BYTES)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('runs selected task ids in the provided order', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end(FLAC_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const first = { ...song('kg', 'First'), id: 'kg:first', platformSongId: 'first' }
    const second = { ...song('kg', 'Second'), id: 'kg:second', platformSongId: 'second' }
    const firstId = store.createDownloadTask('playlist-1', 'Singer', first, 'flac')
    const secondId = store.createDownloadTask('playlist-1', 'Singer', second, 'flac')
    const requestedSongs: string[] = []

    const manager = new DownloadManager(store, {
      requestMusicUrl: async (_platform, info) => {
        requestedSongs.push(String(info.name))
        return { url: `http://127.0.0.1:${port}/ok` }
      },
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'), 1)

    await manager.runPending([secondId, firstId])

    expect(requestedSongs).toEqual(['Second', 'First'])
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('stops running downloads when the manager is cancelled', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.write('fLaC')
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 20)
      res.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const taskId = store.createDownloadTask('playlist-1', 'Singer', song('kg', 'Long Song'), 'flac')
    const manager = new DownloadManager(store, {
      requestMusicUrl: async () => ({ url: `http://127.0.0.1:${port}/slow` }),
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'), 1)

    const pending = manager.runPending([taskId])
    await new Promise((resolve) => setTimeout(resolve, 80))
    manager.cancel()
    await pending

    expect(store.listDownloadTasks()[0]).toMatchObject({ status: 'cancelled', statusText: '已暂停' })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('rejects invalid FLAC payloads and falls back to the next candidate platform', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end(req.url === '/bad' ? 'encrypted-or-error-payload' : FLAC_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const kgSong = song('kg', 'Song')
    const txSong = song('tx', 'Song')
    store.createDownloadTask('playlist-1', 'Singer', {
      ...kgSong,
      raw: {
        ...kgSong.raw,
        downloadCandidates: [
          { platform: 'kg', songId: 'kg-1', qualitys: ['flac'], song: kgSong },
          { platform: 'tx', songId: 'tx-1', qualitys: ['flac'], song: txSong },
        ],
      },
    }, 'flac')
    const requestedPlatforms: string[] = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (platform) => {
        requestedPlatforms.push(String(platform))
        return { url: `http://127.0.0.1:${port}/${platform === 'kg' ? 'bad' : 'ok'}` }
      },
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(requestedPlatforms).toEqual(['kg', 'tx'])
    expect(task.status).toBe('success')
    expect(readFileSync(task.filePath).subarray(0, 4).toString('ascii')).toBe('fLaC')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('fails and deletes the target file when every FLAC candidate is invalid', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end('encrypted-or-error-payload')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    store.createDownloadTask('playlist-1', 'Singer', song('kg', 'Song'), 'flac')
    const manager = new DownloadManager(store, {
      requestMusicUrl: async () => ({ url: `http://127.0.0.1:${port}/bad` }),
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(task.status).toBe('failed')
    expect(task.error).toContain('FLAC')
    expect(task.filePath).toBe('')
    expect(task.downloaded).toBe(0)
    expect(task.total).toBe(0)
    expect(existsSync(join(dir, 'downloads', 'Singer', '2025-01-10 Album', '01. Song.flac'))).toBe(false)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('requeues a previous success task when its existing file is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'downloads', 'Song.flac')
    mkdirSync(join(dir, 'downloads'), { recursive: true })
    writeFileSync(filePath, 'encrypted-or-error-payload')
    const store = new JsonStore(join(dir, 'state.json'))
    const taskId = store.createDownloadTask('playlist-1', 'Singer', song('kg', 'Song'), 'flac')
    store.updateDownloadTask(taskId, { status: 'success', filePath, downloaded: 100, total: 100 })

    store.createDownloadTask('playlist-1', 'Singer', song('kg', 'Song'), 'flac')

    expect(existsSync(filePath)).toBe(false)
    expect(store.listDownloadTasks()[0]).toMatchObject({
      status: 'waiting',
      filePath: '',
      downloaded: 0,
      total: 0,
    })
  })

  it('keeps a previous success task when its existing file is reusable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'downloads', 'Song.flac')
    mkdirSync(join(dir, 'downloads'), { recursive: true })
    writeFileSync(filePath, FLAC_BYTES)
    const store = new JsonStore(join(dir, 'state.json'))
    const taskId = store.createDownloadTask('playlist-1', 'Singer', song('kg', 'Song'), 'flac')
    store.updateDownloadTask(taskId, { status: 'success', filePath, downloaded: 100, total: 100 })

    store.createDownloadTask('playlist-1', 'Singer', song('kg', 'Song'), 'flac')

    expect(store.listDownloadTasks()[0]).toMatchObject({
      status: 'success',
      filePath,
      downloaded: 100,
      total: 100,
    })
  })

  it('keeps downloaded folders unrenamed until folder organizer is run manually', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end(FLAC_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    store.createDownloadTask('playlist-1', 'Singer', {
      ...song('kg', 'Song'),
      raw: { publishDate: '2025-01-10', albumSongCount: 99 },
    }, 'flac')
    const manager = new DownloadManager(store, {
      requestMusicUrl: async () => ({ url: `http://127.0.0.1:${port}/ok` }),
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(task.status).toBe('success')
    expect(task.filePath).toContain('Singer\\2025-01-10 Album\\01. Song.flac')
    expect(readFileSync(task.filePath).subarray(0, 4).toString('ascii')).toBe('fLaC')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('does not fall back to other platforms when a task contains only the selected platform candidate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const kgSong = song('kg', 'Song')
    const txSong = song('tx', 'Song')
    store.createDownloadTask('playlist-1', 'Singer', {
      ...kgSong,
      raw: {
        ...kgSong.raw,
        downloadCandidates: [{ platform: 'kg', songId: 'kg-1', qualitys: ['flac'], song: kgSong }],
        hiddenCandidateForTest: { platform: 'tx', song: txSong },
      },
    }, 'flac')
    const requestedPlatforms: string[] = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (platform) => {
        requestedPlatforms.push(String(platform))
        throw new Error('获取URL失败')
      },
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    expect(requestedPlatforms).toEqual(['kg'])
    expect(store.listDownloadTasks()[0].error).toContain('酷狗音乐')
    expect(store.listDownloadTasks()[0].error).not.toContain('QQ音乐')
  })
  it('passes LX-compatible Kugou hashes to custom sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    store.createDownloadTask('playlist-1', 'Singer', {
      ...song('kg', 'Song'),
      platformSongId: 'hash-128',
      qualitys: ['flac', '320k', '128k'],
      raw: {
        hash: 'hash-128',
        '320hash': 'hash-320',
        sqhash: 'hash-flac',
        album_audio_id: 39672953,
        audio_id: 22146367,
        publishDate: '2025-01-10',
        albumSongCount: 1,
      },
    }, 'flac')
    const calls: Array<{ quality: string; info: Record<string, unknown> }> = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (_platform, info, quality) => {
        calls.push({ quality, info })
        throw new Error('stop after capture')
      },
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    expect(calls.map((call) => [call.quality, call.info.hash, call.info.songmid])).toEqual([
      ['flac', 'hash-128', '22146367'],
      ['320k', 'hash-128', '22146367'],
      ['128k', 'hash-128', '22146367'],
    ])
    expect((calls[0].info as any)._types.flac.hash).toBe('hash-flac')
    expect((calls[0].info as any)._types['320k'].hash).toBe('hash-320')
    expect((calls[0].info as any)._types['128k'].hash).toBe('hash-128')
    expect((calls[0].info as any).types).toEqual([
      { type: 'flac', size: 0, hash: 'hash-flac' },
      { type: '320k', size: 0, hash: 'hash-320' },
      { type: '128k', size: 0, hash: 'hash-128' },
    ])
    expect((calls[0].info.meta as any)._qualitys.flac.hash).toBe('hash-flac')
    expect((calls[0].info.meta as any).hash).toBe('hash-128')
    expect((calls[0].info.meta as any).albumAudioId).toBe(39672953)
  })

  it('passes LX-compatible metadata fields for QQ, Netease and Kuwo sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const txSong = {
      ...song('tx', 'QQ Song'),
      platformSongId: 'qq-mid',
      raw: {
        mid: 'qq-mid',
        song_id: 123456,
        file: { media_mid: 'media-mid' },
        album: { mid: 'album-mid' },
        publishDate: '2025-01-10',
        albumSongCount: 1,
      },
    }
    const wySong = {
      ...song('wy', 'WY Song'),
      id: 'wy-song',
      platformSongId: '987654',
      raw: { id: 987654, publishDate: '2025-01-10', albumSongCount: 1 },
    }
    const kwSong = {
      ...song('kw', 'KW Song'),
      id: 'kw-song',
      platformSongId: '765432',
      raw: { rid: 765432, MUSICRID: 'MUSIC_765432', publishDate: '2025-01-10', albumSongCount: 1 },
    }
    store.createDownloadTask('playlist-1', 'Singer', {
      ...txSong,
      raw: {
        ...txSong.raw,
        downloadCandidates: [
          { platform: 'tx', songId: 'qq-mid', qualitys: ['flac'], song: txSong },
          { platform: 'wy', songId: '987654', qualitys: ['flac'], song: wySong },
          { platform: 'kw', songId: '765432', qualitys: ['flac'], song: kwSong },
        ],
      },
    }, 'flac')
    const calls: Array<{ platform: string; info: Record<string, unknown> }> = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (platform, info) => {
        calls.push({ platform, info })
        throw new Error('stop after capture')
      },
      requestLyric: async () => null,
      requestPic: async () => null,
    }, join(dir, 'downloads'))

    await manager.runPending()

    const txInfo = calls.find((call) => call.platform === 'tx')!.info
    const wyInfo = calls.find((call) => call.platform === 'wy')!.info
    const kwInfo = calls.find((call) => call.platform === 'kw')!.info
    expect(txInfo.songmid).toBe('qq-mid')
    expect((txInfo.meta as any).strMediaMid).toBe('media-mid')
    expect((txInfo.meta as any).id).toBe(123456)
    expect((txInfo.meta as any).albumMid).toBe('album-mid')
    expect(wyInfo.songmid).toBe('987654')
    expect((wyInfo.meta as any).songId).toBe('987654')
    expect(kwInfo.songmid).toBe('765432')
    expect((kwInfo.meta as any).songId).toBe('765432')
  })

  it('searches with title artist and album after existing candidates fail, then downloads a strict match', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end(FLAC_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const original = {
      ...song('kg', 'Here We Are'),
      artist: 'Singer',
      albumName: 'Target Album',
      duration: 290,
      qualitys: ['flac'],
    }
    const fallback = {
      ...original,
      id: 'kg:fallback',
      platformSongId: 'fallback-audio-id',
      raw: {
        hash: 'hash-128',
        sqhash: 'hash-flac',
        audio_id: 'fallback-audio-id',
        publishDate: '2025-01-10',
        albumSongCount: 1,
      },
    }
    store.createDownloadTask('playlist-1', 'Singer', original, 'flac')
    const queries: string[] = []
    const requestedIds: Array<unknown> = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (_platform, info) => {
        requestedIds.push(info.songmid)
        if (info.songmid === 'fallback-audio-id') return { url: `http://127.0.0.1:${port}/ok` }
        throw new Error('existing candidate failed')
      },
      requestLyric: async () => null,
      requestPic: async () => null,
      searchSongs: async (query) => {
        queries.push(query)
        return [fallback]
      },
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(queries[0]).toBe('Here We Are Singer Target Album')
    expect(requestedIds).toEqual(['1', 'fallback-audio-id'])
    expect(task.status).toBe('success')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('uses same-title same-artist duration-matched search fallback when album differs', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end(FLAC_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const original = {
      ...song('kg', '造物者'),
      artist: '华晨宇',
      albumName: '造物者',
      duration: 191,
      qualitys: ['flac'],
      raw: { hash: 'kg-hash', audio_id: '22113473' },
    }
    const wyFallback = {
      ...song('wy', '造物者'),
      id: 'wy:419250437',
      platformSongId: '419250437',
      artist: '华晨宇',
      albumName: 'H',
      duration: 191,
      qualitys: ['flac'],
      raw: { id: 419250437 },
    }
    store.createDownloadTask('playlist-1', '华晨宇', original, 'flac')
    const requested: Array<[string, unknown]> = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (platform, info) => {
        requested.push([platform, info.songmid])
        if (platform === 'wy') return { url: `http://127.0.0.1:${port}/ok` }
        throw new Error('no url')
      },
      requestLyric: async () => null,
      requestPic: async () => null,
      searchSongs: async () => [wyFallback],
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(requested).toEqual([['kg', '22113473'], ['wy', '419250437']])
    expect(task.status).toBe('success')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('keeps relaxed same-song fallback candidates after strict album candidates', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'audio/flac')
      res.end(FLAC_BYTES)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const original = {
      ...song('kg', 'Creator'),
      artist: 'Singer',
      albumName: 'Creator',
      duration: 191,
      qualitys: ['flac'],
      raw: { hash: 'kg-hash', audio_id: '22113473' },
    }
    const strictKg = {
      ...original,
      id: 'kg:strict',
      platformSongId: '22113473',
      raw: { hash: 'kg-hash', audio_id: '22113473' },
    }
    const relaxedWy = {
      ...song('wy', 'Creator'),
      id: 'wy:419250437',
      platformSongId: '419250437',
      artist: 'Singer',
      albumName: 'Different Album',
      duration: 192,
      qualitys: ['flac'],
      raw: { id: 419250437 },
    }
    store.createDownloadTask('playlist-1', 'Singer', original, 'flac')
    const requested: Array<[string, unknown]> = []
    const manager = new DownloadManager(store, {
      requestMusicUrl: async (platform, info) => {
        requested.push([platform, info.songmid])
        if (platform === 'wy') return { url: `http://127.0.0.1:${port}/ok` }
        throw new Error('no url')
      },
      requestLyric: async () => null,
      requestPic: async () => null,
      searchSongs: async () => [strictKg, relaxedWy],
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(requested).toEqual([['kg', '22113473'], ['kg', '22113473'], ['wy', '419250437']])
    expect(task.status).toBe('success')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('does not use fallback search results with a mismatched album when album search found candidates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-'))
    tempDirs.push(dir)
    const store = new JsonStore(join(dir, 'state.json'))
    const original = {
      ...song('kg', 'Here We Are'),
      artist: 'Singer',
      albumName: 'Target Album',
      duration: 290,
      qualitys: ['flac'],
    }
    const liveVersion = {
      ...original,
      id: 'kg:live',
      platformSongId: 'live-id',
      albumName: 'Live Album',
      title: 'Here We Are (Live)',
      duration: 290,
      raw: { hash: 'live-id' },
    }
    store.createDownloadTask('playlist-1', 'Singer', original, 'flac')
    const manager = new DownloadManager(store, {
      requestMusicUrl: async () => {
        throw new Error('no url')
      },
      requestLyric: async () => null,
      requestPic: async () => null,
      searchSongs: async () => [liveVersion],
    }, join(dir, 'downloads'))

    await manager.runPending()

    const [task] = store.listDownloadTasks()
    expect(task.status).toBe('failed')
    expect(task.error).toContain('搜索兜底未找到严格匹配歌曲')
  })
})

function song(platform: string, title: string): Song {
  return {
    id: `${platform}:1`,
    platform,
    platformSongId: '1',
    title,
    artist: 'Singer',
    albumId: `${platform}:a1`,
    albumName: 'Album',
    duration: 180,
    trackNo: 1,
    qualitys: ['flac'],
    raw: { publishDate: '2025-01-10', albumSongCount: 1 },
  }
}
