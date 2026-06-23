import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enhanceCoverUrl, mergeLyrics, writeMetadata } from '../src/main/core/metadata'
import type { Song } from '../src/main/core/types'

const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
)
const WEBP_1X1 = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')

describe('metadata helpers', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('requests larger netease covers', () => {
    expect(enhanceCoverUrl('https://p1.music.126.net/a/b.jpg')).toBe('https://p1.music.126.net/a/b.jpg?param=500y500')
    expect(enhanceCoverUrl('https://p1.music.126.net/a/b.jpg?x=1')).toBe('https://p1.music.126.net/a/b.jpg?x=1&param=500y500')
  })

  it('merges translated and lx lyrics when enabled', () => {
    expect(
      mergeLyrics(
        { lyric: '[00:00.00]原词', tlyric: '[00:00.00]翻译', lxlyric: '[0,100]逐字' },
        { translated: true, romanized: false, lx: true },
      ),
    ).toContain('翻译')
  })

  it('prefers JPEG covers for FLAC metadata even when the server can return WebP', async () => {
    const { url, requests, close } = await startCoverServer()
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-meta-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'song.flac')
    writeFileSync(filePath, bareFlac())

    await writeMetadata(filePath, song(), null, url)

    const bytes = readFileSync(filePath)
    expect(requests.every((accept) => !accept.includes('image/webp') && !accept.includes('image/avif'))).toBe(true)
    expect(bytes.includes(Buffer.from('image/jpeg'))).toBe(true)
    expect(bytes.includes(Buffer.from('image/webp'))).toBe(false)
    await close()
  })

  it('prefers JPEG covers for MP3 APIC metadata even when the server can return WebP', async () => {
    const { url, requests, close } = await startCoverServer()
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-meta-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'song.mp3')
    writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x64]))

    await writeMetadata(filePath, song(), null, url)

    const nodeId3 = await import('node-id3')
    const tags = (nodeId3.default || nodeId3).read(filePath) as any
    expect(requests.every((accept) => !accept.includes('image/webp') && !accept.includes('image/avif'))).toBe(true)
    expect(tags.image?.mime).toBe('image/jpeg')
    await close()
  })

  it('requests high resolution kugou stdmusic covers before embedding metadata', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      requests.push(String(input))
      return new Response(JPEG_1X1, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    })
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-meta-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'song.mp3')
    writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x64]))

    await writeMetadata(filePath, song(), null, 'http://imge.kugou.com/stdmusic/500/20200101/cover.jpg')

    expect(requests[0]).toContain('/stdmusic/1000/')
  })
})

function bareFlac(): Buffer {
  return Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x80, 0x00, 0x00, 0x22]),
    Buffer.alloc(34),
  ])
}

async function startCoverServer(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    const accept = String(req.headers.accept || '')
    requests.push(accept)
    if (accept.includes('image/webp') || accept.includes('image/avif')) {
      res.setHeader('content-type', 'image/webp')
      res.end(WEBP_1X1)
      return
    }
    res.setHeader('content-type', 'image/jpeg')
    res.end(JPEG_1X1)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  return {
    url: `http://127.0.0.1:${port}/cover.jpg`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function song(): Song {
  return {
    id: 'kw:1',
    platform: 'kw',
    platformSongId: '1',
    title: 'Song',
    artist: 'Singer',
    albumId: 'album-1',
    albumName: 'Album',
    duration: 180,
    trackNo: 1,
    qualitys: ['flac'],
    raw: {},
  }
}
