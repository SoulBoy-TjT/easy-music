import fs from 'node:fs'
import path from 'node:path'
import type { Song } from './types'

const INVALID_NAME_RE = /[<>:"/\\|?*\u0000-\u001f]/g
const TRAILING_DOTS_RE = /[. ]+$/g
const COMPARE_PUNCTUATION_RE = /[\s\-_.·・、，,。；;：:"“”‘’'!?！？()[\]（）【】《》<>/\\|]+/g
const ALBUM_COUNT_SUFFIX_RE = /\s\(\d+首\)$/u
const ARTIST_COUNT_SUFFIX_RE = /（\d+首）$/u
const PUBLISH_DATE_KEYS = [
  'publishDate',
  'publish_date',
  'detailPublishDate',
  'detail_publish_date',
  'albumPublishDate',
  'album_publish_date',
  'publishtime',
  'publish_time',
  'publishTime',
  'album_publish_time',
  'releaseTime',
  'release_time',
  'releasedate',
  'releaseDate',
  'RELEASEDATE',
  'public_time',
  'publicTime',
  'Fpublic_time',
  'time_public',
  'pub_time',
  'pubTime',
  'pub',
  'date',
]
const PUBLISH_DATE_LIST_KEYS = ['searchItems', 'search_items']

export function sanitizeName(value: string, fallback = '未命名'): string {
  const cleaned = String(value || '')
    .replace(INVALID_NAME_RE, '_')
    .replace(TRAILING_DOTS_RE, '')
    .trim()
  return cleaned || fallback
}

export function normalizeCompareText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(COMPARE_PUNCTUATION_RE, '')
}

export function buildAlbumBaseFolderName(albumName: string, publishDate = ''): string {
  const safeAlbum = sanitizeName(albumName || '未知专辑', '未知专辑')
  const date = publishDate && /^\d{4}-\d{2}-\d{2}$/.test(publishDate) ? `${publishDate} ` : ''
  return `${date}${safeAlbum}`
}

export function buildAlbumFolderName(albumName: string, publishDate = '', actualSongCount = 0): string {
  return `${buildAlbumBaseFolderName(albumName, publishDate)} (${Math.max(0, Math.trunc(actualSongCount || 0))}首)`
}

export function buildArtistFolderName(artistName: string, actualSongCount: number): string {
  return `${sanitizeName(artistName, '未命名歌手')}（${Math.max(0, Math.trunc(actualSongCount || 0))}首）`
}

export function stripAlbumSongCountSuffix(value: string): string {
  return String(value || '').replace(ALBUM_COUNT_SUFFIX_RE, '')
}

export function stripArtistSongCountSuffix(value: string): string {
  return String(value || '').replace(ARTIST_COUNT_SUFFIX_RE, '')
}

export function buildSongFileName(song: Song, ext: string): string {
  const safeTitle = sanitizeName(song.title, '未命名歌曲')
  const cleanExt = String(ext || 'mp3').replace(/^\./, '')
  return song.trackNo > 0 ? `${String(song.trackNo).padStart(2, '0')}. ${safeTitle}.${cleanExt}` : `${safeTitle}.${cleanExt}`
}

export function resolveSongFilePath(
  root: string,
  playlistArtistName: string,
  song: Song,
  ext: string,
  options: { publishDate?: string; albumSongCount?: number } = {},
): string {
  const artistFolder = resolveArtistFolderName(root, playlistArtistName)
  const artistDir = path.win32.join(root, artistFolder)
  return path.win32.join(
    root,
    artistFolder,
    resolveAlbumFolderName(artistDir, song.albumName, options.publishDate || readPublishDate(song.raw)),
    buildSongFileName(song, ext),
  )
}

export function resolveArtistFolderName(root: string, artistName: string): string {
  const safeArtist = sanitizeName(artistName, '未命名歌手')
  return findExistingFolderName(root, safeArtist, stripArtistSongCountSuffix) || safeArtist
}

export function resolveAlbumFolderName(artistDir: string, albumName: string, publishDate = ''): string {
  const baseName = buildAlbumBaseFolderName(albumName, publishDate)
  return findExistingFolderName(artistDir, baseName, stripAlbumSongCountSuffix) || baseName
}

export function extForQuality(quality: string): string {
  if (quality === 'flac' || quality === 'flac24bit') return 'flac'
  return 'mp3'
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readPublishDate(raw: Record<string, unknown> = {}): string {
  const direct = readPublishDateFromRecord(raw)
  if (direct) return direct

  for (const listKey of PUBLISH_DATE_LIST_KEYS) {
    const items = raw[listKey]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const date = readPublishDateFromRecord(item as Record<string, unknown>)
      if (date) return date
    }
  }
  return ''
}

export function readNumber(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function findExistingFolderName(parentDir: string, baseName: string, stripCount: (value: string) => string): string {
  if (!fs.existsSync(parentDir)) return ''
  const matches = fs.readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && stripCount(entry.name) === baseName)
    .map((entry) => entry.name)
  if (!matches.length) return ''
  matches.sort((left, right) => {
    const leftCounted = stripCount(left) !== left
    const rightCounted = stripCount(right) !== right
    if (leftCounted !== rightCounted) return leftCounted ? -1 : 1
    return left.localeCompare(right, 'zh-Hans-CN')
  })
  return matches[0]
}

function readPublishDateFromRecord(raw: Record<string, unknown>): string {
  for (const key of PUBLISH_DATE_KEYS) {
    const date = normalizePublishDate(readString(raw[key]))
    if (date) return date
  }
  return ''
}

function normalizePublishDate(value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const timestamp = Number(raw)
  if (/^\d+$/.test(raw) && Number.isFinite(timestamp) && timestamp > 10_000_000) {
    const ms = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
    return new Date(ms).toISOString().slice(0, 10)
  }
  const match = raw.match(/(\d{4})(?:[-/.年](\d{1,2}))?(?:[-/.月](\d{1,2}))?/)
  if (!match) return ''
  const month = match[2] || '1'
  const day = match[3] || '1'
  return `${match[1]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}
