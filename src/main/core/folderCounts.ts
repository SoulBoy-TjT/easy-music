import fs from 'node:fs'
import path from 'node:path'
import {
  buildAlbumFolderName,
  buildArtistFolderName,
  sanitizeName,
  stripAlbumSongCountSuffix,
  stripArtistSongCountSuffix,
} from './naming'
import { validateDownloadedAudioFile } from './audioValidation'

export interface PathRename {
  from: string
  to: string
}

export interface FolderNormalizeResult {
  renames: PathRename[]
  invalidFiles: string[]
  deletedDirs: string[]
}

const AUDIO_EXT_RE = /\.(?:mp3|flac|ape|m4a|wav)$/i
const VALIDATED_AUDIO_EXT_RE = /\.(?:mp3|flac)$/i

export function normalizeDownloadedFolders(root: string, artistNames: string[]): PathRename[] {
  return normalizeDownloadedFoldersWithCleanup(root, artistNames).renames
}

export function normalizeDownloadedFoldersWithCleanup(root: string, artistNames: string[]): FolderNormalizeResult {
  const renames: PathRename[] = []
  const invalidFiles: string[] = []
  const deletedDirs: string[] = []
  for (const artistName of Array.from(new Set(artistNames.filter(Boolean)))) {
    const artistDir = findArtistDir(root, artistName)
    if (!artistDir) continue
    validateArtistAudioFiles(artistDir, invalidFiles)
    removeEmptyAlbumDirs(artistDir, deletedDirs)
    const normalizedArtistDir = normalizeArtistDir(artistDir, artistName, renames)
    removeEmptyAlbumDirs(normalizedArtistDir, deletedDirs)
    normalizeAlbumDirs(normalizedArtistDir, renames)
  }
  return { renames, invalidFiles, deletedDirs }
}

export function applyPathRenames(filePath: string, renames: PathRename[]): string {
  let result = filePath
  for (const rename of renames) {
    const from = normalizePath(rename.from)
    const current = normalizePath(result)
    if (current === from || current.startsWith(`${from}\\`)) {
      result = `${rename.to}${result.slice(rename.from.length)}`
    }
  }
  return result
}

function normalizeArtistDir(artistDir: string, artistName: string, renames: PathRename[]): string {
  normalizeAlbumDirs(artistDir, renames)
  const total = countAudioFiles(artistDir)
  const target = path.join(path.dirname(artistDir), buildArtistFolderName(artistName, total))
  return renameDirIfNeeded(artistDir, target, renames)
}

function normalizeAlbumDirs(artistDir: string, renames: PathRename[]): void {
  if (!fs.existsSync(artistDir)) return
  for (const entry of fs.readdirSync(artistDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const albumDir = path.join(artistDir, entry.name)
    const baseName = stripAlbumSongCountSuffix(entry.name)
    const count = countAudioFiles(albumDir)
    if (count <= 0) continue
    const target = path.join(artistDir, buildAlbumFolderName(baseName, '', count))
    renameDirIfNeeded(albumDir, target, renames)
  }
}

function validateArtistAudioFiles(artistDir: string, invalidFiles: string[]): void {
  if (!fs.existsSync(artistDir)) return
  for (const entry of fs.readdirSync(artistDir, { withFileTypes: true })) {
    const fullPath = path.join(artistDir, entry.name)
    if (entry.isDirectory()) {
      validateArtistAudioFiles(fullPath, invalidFiles)
      continue
    }
    if (!entry.isFile() || !VALIDATED_AUDIO_EXT_RE.test(entry.name)) continue
    const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase()
    try {
      validateDownloadedAudioFile(fullPath, ext)
    } catch {
      fs.rmSync(fullPath, { force: true })
      invalidFiles.push(fullPath)
    }
  }
}

function removeEmptyAlbumDirs(artistDir: string, deletedDirs: string[]): void {
  if (!fs.existsSync(artistDir)) return
  for (const entry of fs.readdirSync(artistDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const albumDir = path.join(artistDir, entry.name)
    removeEmptyAlbumDirs(albumDir, deletedDirs)
    if (isEmptyDir(albumDir)) {
      fs.rmdirSync(albumDir)
      deletedDirs.push(albumDir)
    }
  }
}

function isEmptyDir(dir: string): boolean {
  return fs.existsSync(dir) && fs.readdirSync(dir).length === 0
}

function findArtistDir(root: string, artistName: string): string {
  if (!fs.existsSync(root)) return ''
  const safeArtist = sanitizeName(artistName, '未命名歌手')
  const matches = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && stripArtistSongCountSuffix(entry.name) === safeArtist)
    .map((entry) => path.join(root, entry.name))
  if (!matches.length) return ''
  matches.sort((left, right) => {
    const leftCounted = stripArtistSongCountSuffix(path.basename(left)) !== path.basename(left)
    const rightCounted = stripArtistSongCountSuffix(path.basename(right)) !== path.basename(right)
    if (leftCounted !== rightCounted) return leftCounted ? -1 : 1
    return left.localeCompare(right, 'zh-Hans-CN')
  })
  return matches[0]
}

function countAudioFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let count = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) count += countAudioFiles(fullPath)
    else if (entry.isFile() && AUDIO_EXT_RE.test(entry.name)) count += 1
  }
  return count
}

function renameDirIfNeeded(from: string, to: string, renames: PathRename[]): string {
  if (normalizePath(from) === normalizePath(to)) return to
  if (fs.existsSync(to)) return from
  fs.renameSync(from, to)
  renames.push({ from, to })
  return to
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').toLowerCase()
}
