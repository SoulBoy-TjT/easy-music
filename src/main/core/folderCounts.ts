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
  removedFiles: string[]
  albumOrderWarnings: string[]
}

export interface ArtistFolderInfo {
  name: string
  path: string
  artistName: string
  songCount: number
  targetName: string
  targetPath: string
  needsRename: boolean
  warnings: string[]
}

export interface ArtistFolderScanResult {
  root: string
  items: ArtistFolderInfo[]
}

export interface ArtistFolderNormalizeItem extends ArtistFolderInfo {
  originalName: string
  originalPath: string
  renamed: boolean
}

export interface SelectedArtistFolderNormalizeResult {
  root: string
  items: ArtistFolderNormalizeItem[]
  renames: PathRename[]
  invalidFiles: string[]
  deletedDirs: string[]
  removedFiles: string[]
}

export interface NormalizeSelectedArtistFoldersOptions {
  beforeArtistRename?: (artistDir: string) => void
}

interface FolderStepContext {
  root: string
  folderName: string
  step: string
  currentPath?: string
  targetPath?: string
}

const AUDIO_EXT_RE = /\.(?:mp3|flac)$/i
const VALIDATED_AUDIO_EXT_RE = /\.(?:mp3|flac)$/i
const RENAME_RETRY_DELAYS_MS = [150, 300, 600, 1000]

export function normalizeDownloadedFolders(root: string, artistNames: string[]): PathRename[] {
  return normalizeDownloadedFoldersWithCleanup(root, artistNames).renames
}

export function normalizeDownloadedFoldersWithCleanup(root: string, artistNames: string[]): FolderNormalizeResult {
  const folderNames = Array.from(new Set(artistNames
    .map((artistName) => path.basename(findArtistDir(root, artistName)))
    .filter(Boolean)))
  const result = normalizeSelectedArtistFolders(root, folderNames)
  return {
    renames: result.renames,
    invalidFiles: result.invalidFiles,
    deletedDirs: result.deletedDirs,
    removedFiles: result.removedFiles,
    albumOrderWarnings: result.items.flatMap((item) => item.warnings),
  }
}

export function scanArtistFolders(root: string): ArtistFolderScanResult {
  if (!fs.existsSync(root)) return { root, items: [] }
  const items = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => artistFolderInfo(root, entry.name))
    .filter((item): item is ArtistFolderInfo => !!item && item.songCount > 0)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
  return { root, items }
}

export function normalizeSelectedArtistFolders(root: string, folderNames: string[], options: NormalizeSelectedArtistFoldersOptions = {}): SelectedArtistFolderNormalizeResult {
  const renames: PathRename[] = []
  const invalidFiles: string[] = []
  const deletedDirs: string[] = []
  const removedFiles: string[] = []
  const items: ArtistFolderNormalizeItem[] = []
  const selected = new Set(folderNames.filter(Boolean))
  if (!fs.existsSync(root) || !selected.size) return { root, items, renames, invalidFiles, deletedDirs, removedFiles }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !selected.has(entry.name)) continue
    const originalName = entry.name
    const originalPath = path.join(root, originalName)
    const artistName = stripArtistSongCountSuffix(originalName)
    const artistDir = originalPath
    if (!artistDir) continue
    removeNonFinalAudioFiles(artistDir, removedFiles, root, originalName)
    validateArtistAudioFiles(artistDir, invalidFiles, root, originalName)
    removeEmptyAlbumDirs(artistDir, deletedDirs, root, originalName)
    normalizeAlbumDirs(artistDir, renames, root, originalName)
    options.beforeArtistRename?.(artistDir)
    const normalizedArtistDir = normalizeArtistDir(artistDir, artistName, renames, root, originalName)
    removeEmptyAlbumDirs(normalizedArtistDir, deletedDirs, root, originalName)
    normalizeAlbumDirs(normalizedArtistDir, renames, root, originalName)
    const info = artistFolderInfo(path.dirname(normalizedArtistDir), path.basename(normalizedArtistDir))
    if (!info) continue
    items.push({
      ...info,
      originalName,
      originalPath,
      renamed: normalizePath(originalPath) !== normalizePath(normalizedArtistDir),
    })
  }
  return { root, items, renames, invalidFiles, deletedDirs, removedFiles }
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

function normalizeArtistDir(artistDir: string, artistName: string, renames: PathRename[], root?: string, folderName?: string): string {
  return runFolderStep({
    root: root || path.dirname(artistDir),
    folderName: folderName || path.basename(artistDir),
    step: '重命名歌手文件夹',
    currentPath: artistDir,
  }, () => {
    const total = countAudioFiles(artistDir)
    const target = path.join(path.dirname(artistDir), buildArtistFolderName(artistName, total))
    return runFolderStep({
      root: root || path.dirname(artistDir),
      folderName: folderName || path.basename(artistDir),
      step: '重命名歌手文件夹',
      currentPath: artistDir,
      targetPath: target,
    }, () => renameDirIfNeeded(artistDir, target, renames))
  })
}

function normalizeAlbumDirs(artistDir: string, renames: PathRename[], root?: string, folderName?: string): void {
  if (!fs.existsSync(artistDir)) return
  for (const entry of fs.readdirSync(artistDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const albumDir = path.join(artistDir, entry.name)
    const baseName = stripAlbumSongCountSuffix(entry.name)
    runFolderStep({
      root: root || path.dirname(artistDir),
      folderName: folderName || path.basename(artistDir),
      step: '重命名专辑文件夹',
      currentPath: albumDir,
    }, () => {
      const count = countAudioFiles(albumDir)
      if (count <= 0) return
      const target = path.join(artistDir, buildAlbumFolderName(baseName, '', count))
      runFolderStep({
        root: root || path.dirname(artistDir),
        folderName: folderName || path.basename(artistDir),
        step: '重命名专辑文件夹',
        currentPath: albumDir,
        targetPath: target,
      }, () => renameDirIfNeeded(albumDir, target, renames))
    })
  }
}

function artistFolderInfo(root: string, folderName: string): ArtistFolderInfo | null {
  const folderPath = path.join(root, folderName)
  if (!fs.existsSync(folderPath)) return null
  const artistName = stripArtistSongCountSuffix(folderName)
  const songCount = countAudioFiles(folderPath)
  const targetName = buildArtistFolderName(artistName, songCount)
  const targetPath = path.join(root, targetName)
  const warnings: string[] = []
  collectAlbumOrderWarnings(folderPath, warnings)
  return {
    name: folderName,
    path: folderPath,
    artistName,
    songCount,
    targetName,
    targetPath,
    needsRename: normalizePath(folderPath) !== normalizePath(targetPath),
    warnings,
  }
}

function removeNonFinalAudioFiles(artistDir: string, removedFiles: string[], root?: string, folderName?: string): void {
  if (!fs.existsSync(artistDir)) return
  for (const entry of fs.readdirSync(artistDir, { withFileTypes: true })) {
    const fullPath = path.join(artistDir, entry.name)
    if (entry.isDirectory()) {
      removeNonFinalAudioFiles(fullPath, removedFiles, root, folderName)
      continue
    }
    if (entry.isFile() && !AUDIO_EXT_RE.test(entry.name)) {
      runFolderStep({
        root: root || path.dirname(artistDir),
        folderName: folderName || path.basename(artistDir),
        step: '清理非 FLAC/MP3 文件',
        currentPath: fullPath,
      }, () => fs.rmSync(fullPath, { force: true }))
      removedFiles.push(fullPath)
    }
  }
}

function collectAlbumOrderWarnings(artistDir: string, warnings: string[]): void {
  if (!fs.existsSync(artistDir)) return
  for (const entry of fs.readdirSync(artistDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const albumDir = path.join(artistDir, entry.name)
    collectAlbumOrderWarnings(albumDir, warnings)
    const duplicates = findDuplicateTrackNumbers(albumDir)
    if (duplicates.length) {
      warnings.push(`专辑歌曲排序异常：${albumDir}，重复曲序：${duplicates.join('、')}`)
    }
  }
}

function findDuplicateTrackNumbers(albumDir: string): string[] {
  const counts = new Map<string, number>()
  for (const entry of fs.readdirSync(albumDir, { withFileTypes: true })) {
    if (!entry.isFile() || !AUDIO_EXT_RE.test(entry.name)) continue
    const match = entry.name.match(/^(\d+)\./)
    if (!match) continue
    const trackNo = match[1].padStart(2, '0')
    counts.set(trackNo, (counts.get(trackNo) || 0) + 1)
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([trackNo]) => trackNo)
    .sort((left, right) => Number(left) - Number(right))
}

function validateArtistAudioFiles(artistDir: string, invalidFiles: string[], root?: string, folderName?: string): void {
  if (!fs.existsSync(artistDir)) return
  for (const entry of fs.readdirSync(artistDir, { withFileTypes: true })) {
    const fullPath = path.join(artistDir, entry.name)
    if (entry.isDirectory()) {
      validateArtistAudioFiles(fullPath, invalidFiles, root, folderName)
      continue
    }
    if (!entry.isFile() || !VALIDATED_AUDIO_EXT_RE.test(entry.name)) continue
    const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase()
    try {
      validateDownloadedAudioFile(fullPath, ext)
    } catch {
      runFolderStep({
        root: root || path.dirname(artistDir),
        folderName: folderName || path.basename(artistDir),
        step: '删除校验失败的音频文件',
        currentPath: fullPath,
      }, () => fs.rmSync(fullPath, { force: true }))
      invalidFiles.push(fullPath)
    }
  }
}

function removeEmptyAlbumDirs(artistDir: string, deletedDirs: string[], root?: string, folderName?: string): void {
  if (!fs.existsSync(artistDir)) return
  for (const entry of fs.readdirSync(artistDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const albumDir = path.join(artistDir, entry.name)
    removeEmptyAlbumDirs(albumDir, deletedDirs, root, folderName)
    if (isEmptyDir(albumDir)) {
      runFolderStep({
        root: root || path.dirname(artistDir),
        folderName: folderName || path.basename(artistDir),
        step: '删除空目录',
        currentPath: albumDir,
      }, () => fs.rmdirSync(albumDir))
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
  try {
    renameSyncWithRetry(from, to)
  } catch (error) {
    if (!isRetryableRenameError(error) || fs.existsSync(to)) throw error
    moveDirectoryContentsWithRetry(from, to)
  }
  renames.push({ from, to })
  return to
}

function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : ''
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function moveDirectoryContentsWithRetry(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    movePathWithRetry(path.join(from, entry.name), path.join(to, entry.name))
  }
  try {
    removeEmptyDirWithRetry(from)
  } catch (error) {
    if (!isEmptyDir(from)) throw error
  }
}

function movePathWithRetry(from: string, to: string): void {
  if (fs.existsSync(to)) throw new Error(`目标路径已存在：${to}`)
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

function removeEmptyDirWithRetry(dir: string): void {
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      fs.rmdirSync(dir)
      return
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4)
  const view = new Int32Array(buffer)
  Atomics.wait(view, 0, 0, ms)
}

function runFolderStep<T>(context: FolderStepContext, action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('文件夹整理失败')) throw error
    throw new Error(formatFolderStepError(context, error))
  }
}

function formatFolderStepError(context: FolderStepContext, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const lines = [
    '文件夹整理失败',
    `父目录：${context.root}`,
    `歌手文件夹：${context.folderName}`,
    `步骤：${context.step}`,
  ]
  if (context.currentPath) lines.push(`当前路径：${context.currentPath}`)
  if (context.targetPath) lines.push(`目标路径：${context.targetPath}`)
  lines.push(`原因：${message || '未知错误'}`)
  return lines.join('\n')
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').toLowerCase()
}
