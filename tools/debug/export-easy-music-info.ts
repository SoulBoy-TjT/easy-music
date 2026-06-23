import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toLxMusicInfo } from '../../src/main/core/downloadManager'
import type { Platform, Quality, Song } from '../../src/main/core/types'
import { searchPlatformSongs } from '../../src/main/platforms'

export interface EasyMusicDebugOptions {
  query: string
  title: string
  artist: string
  album: string
  platform?: Platform
  qualities?: Quality[]
  limit?: number
}

export interface EasyMusicDebugAttempt {
  quality: Quality
  musicId: string
  musicInfo: Record<string, unknown>
}

export interface EasyMusicDebugSnapshot {
  generatedAt: string
  query: string
  target: {
    title: string
    artist: string
    album: string
    platform?: Platform
  }
  selectedSong: Song
  attempts: EasyMusicDebugAttempt[]
}

const DEFAULT_OUTPUT = path.join(os.homedir(), 'AppData', 'Roaming', 'easy-music', 'debug-easy-music-info.json')

export async function buildEasyMusicDebugSnapshot(options: EasyMusicDebugOptions): Promise<EasyMusicDebugSnapshot> {
  const qualities = options.qualities?.length ? options.qualities : ['flac', '320k', '128k']
  const platforms = options.platform ? [options.platform] : ['kg', 'tx', 'wy', 'kw']
  const songs = await searchPlatformSongs(options.query, platforms, options.limit ?? 20)
  const selectedSong = songs.find((song) => isTargetSong(song, options)) || songs[0]
  if (!selectedSong) throw new Error(`未搜索到歌曲：${options.query}`)

  return {
    generatedAt: new Date().toISOString(),
    query: options.query,
    target: {
      title: options.title,
      artist: options.artist,
      album: options.album,
      platform: options.platform,
    },
    selectedSong,
    attempts: qualities.map((quality) => {
      const musicInfo = toLxMusicInfo(selectedSong, quality)
      return {
        quality,
        musicId: String(musicInfo.hash || musicInfo.songmid || ''),
        musicInfo,
      }
    }),
  }
}

export function writeEasyMusicDebugSnapshot(snapshot: EasyMusicDebugSnapshot, output = DEFAULT_OUTPUT): string {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(snapshot, null, 2), 'utf8')
  return output
}

function isTargetSong(song: Song, options: EasyMusicDebugOptions): boolean {
  if (options.platform && song.platform !== options.platform) return false
  return normalize(song.title) === normalize(options.title)
    && normalize(song.artist).includes(normalize(options.artist))
    && normalize(song.albumName) === normalize(options.album)
}

function normalize(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[\s()[\]（）【】《》"'.,，。:：;；·_-]+/g, '')
}

function readArg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  return process.argv[index + 1] || fallback
}

async function main(): Promise<void> {
  const options: EasyMusicDebugOptions = {
    query: readArg('query', '造物者 华晨宇'),
    title: readArg('title', '造物者'),
    artist: readArg('artist', '华晨宇'),
    album: readArg('album', '造物者'),
    platform: (readArg('platform', 'kg') || 'kg') as Platform,
    qualities: readArg('qualities', 'flac,320k,128k').split(',').map((item) => item.trim()).filter(Boolean) as Quality[],
    limit: Number(readArg('limit', '20')) || 20,
  }
  const output = readArg('output', DEFAULT_OUTPUT)
  const snapshot = await buildEasyMusicDebugSnapshot(options)
  const written = writeEasyMusicDebugSnapshot(snapshot, output)
  console.log(`easy-music 参数已写入：${written}`)
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
