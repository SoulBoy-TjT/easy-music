import fs from 'node:fs'
import path from 'node:path'
import type { Lyrics, Song } from './types'

const FLAC_VENDOR = 'reference libFLAC 1.2.1 20070917'
const COMPATIBLE_COVER_ACCEPT = 'image/jpeg,image/png,image/*,*/*;q=0.8'

export function enhanceCoverUrl(url: string): string {
  if (!url) return ''
  if (url.includes('music.126.net') && !/[?&]param=\d+y\d+/.test(url)) {
    return `${url}${url.includes('?') ? '&' : '?'}param=500y500`
  }
  return url
}

export function mergeLyrics(
  lyrics: Lyrics | null,
  options: { translated: boolean; romanized: boolean; lx: boolean } = { translated: true, romanized: true, lx: true },
): string {
  if (!lyrics) return ''
  let result = lyrics.lyric || ''
  const translated = lyrics.translated || lyrics.tlyric || ''
  const romanized = lyrics.romanized || lyrics.rlyric || ''
  if (options.translated && translated) result = `${result.trim()}\n\n${translated.trim()}`.trim()
  if (options.romanized && romanized) result = `${result.trim()}\n\n${romanized.trim()}`.trim()
  if (options.lx && lyrics.lxlyric) result = `${result.trim()}\n\n${lyrics.lxlyric.trim()}`.trim()
  return result
}

export async function writeMetadata(filePath: string, song: Song, lyrics: Lyrics | null, coverUrl: string | null): Promise<void> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.ape') return
  const cover = coverUrl ? await fetchCover(enhanceCoverUrl(coverUrl)).catch(() => null) : null
  if (ext === '.mp3') {
    await writeMp3Metadata(filePath, song, lyrics, cover)
    return
  }
  if (ext === '.flac') {
    await writeFlacMetadata(filePath, song, lyrics, cover)
  }
}

async function writeMp3Metadata(filePath: string, song: Song, lyrics: Lyrics | null, cover: CoverData | null): Promise<void> {
  const nodeId3 = await import('node-id3')
  const tags: Record<string, unknown> = {
    title: song.title,
    artist: song.artist,
    album: song.albumName,
  }
  const lyricText = mergeLyrics(lyrics)
  if (lyricText) {
    tags.unsynchronisedLyrics = {
      language: 'zho',
      text: lyricText,
    }
  }
  if (lyrics?.translated || lyrics?.tlyric) {
    tags.userDefinedText = [{
      description: 'LYRICS_TRANSLATION',
      value: lyrics.translated || lyrics.tlyric,
    }]
  }
  if (cover) {
    tags.APIC = {
      mime: cover.mimeType,
      type: {
        id: 3,
        name: 'front cover',
      },
      description: '',
      imageBuffer: cover.buffer,
    }
  }
  await new Promise<void>((resolve, reject) => {
    ;(nodeId3.default || nodeId3).write(tags, filePath, (error: Error | null) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function writeFlacMetadata(filePath: string, song: Song, lyrics: Lyrics | null, cover: CoverData | null): Promise<void> {
  const FlacProcessor = require('../lx/musicMeta/flac-metadata/index.js')
  const lyricText = mergeLyrics(lyrics)
  const comments = [
    `TITLE=${song.title}`,
    `ARTIST=${song.artist}`,
    `ALBUM=${song.albumName}`,
  ]
  if (lyricText) comments.push(`LYRICS=${lyricText}`)
  if (lyrics?.translated || lyrics?.tlyric) comments.push(`LYRICS_TRANSLATION=${lyrics.translated || lyrics.tlyric}`)

  const data: Record<string, unknown> = {
    vorbis: {
      vendor: FLAC_VENDOR,
      comments,
    },
  }
  if (cover) {
    const size = await imageSize(cover.buffer).catch(() => ({ width: 0, height: 0 }))
    data.picture = {
      pictureType: 3,
      mimeType: cover.mimeType,
      description: '',
      width: size.width || 0,
      height: size.height || 0,
      bitsPerPixel: cover.mimeType === 'image/png' ? 32 : 24,
      colors: 0,
      pictureData: cover.buffer,
    }
  }

  await new Promise<void>((resolve, reject) => {
    const tempPath = `${filePath}.lxmtemp`
    const reader = fs.createReadStream(filePath)
    const writer = fs.createWriteStream(tempPath)
    const flacProcessor = new FlacProcessor()
    flacProcessor.writeMeta(data)
    reader.on('error', reject)
    writer.on('error', reject)
    writer.on('finish', async () => {
      try {
        await fs.promises.rm(filePath, { force: true })
        await fs.promises.rename(tempPath, filePath)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    reader.pipe(flacProcessor).pipe(writer)
  })
}

interface CoverData {
  buffer: Buffer
  mimeType: string
  width: number
  height: number
}

async function fetchCover(url: string): Promise<CoverData> {
  const covers: CoverData[] = []
  for (const candidate of buildCoverUrlCandidates(url)) {
    const first = await fetchCoverOnce(candidate).catch(() => null)
    if (!first) continue
    if (first.mimeType !== 'image/webp') {
      covers.push(first)
      continue
    }
    const retry = await fetchCoverOnce(candidate).catch(() => null)
    covers.push(retry && retry.mimeType !== 'image/webp' ? retry : first)
  }
  const best = covers.sort(compareCoverQuality)[0]
  if (!best) throw new Error('封面下载失败')
  return best
}

async function fetchCoverOnce(url: string): Promise<CoverData> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
      Accept: COMPATIBLE_COVER_ACCEPT,
    },
  })
  if (!response.ok) throw new Error(`封面下载失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const mimeType = detectImageMime(buffer) || response.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
  const size = await imageSize(buffer).catch(() => ({ width: 0, height: 0 }))
  return { buffer, mimeType, width: size.width || 0, height: size.height || 0 }
}

function buildCoverUrlCandidates(url: string): string[] {
  const candidates: string[] = []
  try {
    const parsed = new URL(url)
    if (parsed.pathname.includes('/stdmusic/') && /(?:^|\.)kugou\.com$/i.test(parsed.hostname)) {
      for (const size of [1000, 800, 640, 500]) {
        const next = new URL(parsed.toString())
        next.pathname = next.pathname.replace(/\/stdmusic\/\d+\//, `/stdmusic/${size}/`)
        candidates.push(next.toString())
      }
    }
  } catch {}
  candidates.push(url)
  return Array.from(new Set(candidates))
}

function compareCoverQuality(a: CoverData, b: CoverData): number {
  const aCompatible = a.mimeType === 'image/jpeg' || a.mimeType === 'image/png'
  const bCompatible = b.mimeType === 'image/jpeg' || b.mimeType === 'image/png'
  if (aCompatible !== bCompatible) return aCompatible ? -1 : 1
  const areaDiff = (b.width * b.height) - (a.width * a.height)
  if (areaDiff) return areaDiff
  return b.buffer.length - a.buffer.length
}

function detectImageMime(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return ''
}

async function imageSize(buffer: Buffer): Promise<{ width?: number; height?: number }> {
  const mod: any = await import('image-size')
  const fn = mod.imageSize || mod.default || mod
  return fn(buffer)
}
