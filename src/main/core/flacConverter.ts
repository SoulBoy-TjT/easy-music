import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { validateDownloadedAudioFile } from './audioValidation'

export type ConvertStatus = 'waiting' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'
export type ConvertTaskKind = 'flac_to_mp3' | 'copy_mp3'

export interface ConvertTask {
  id: string
  sourcePath: string
  outputPath: string
  kind: ConvertTaskKind
  status: ConvertStatus
  statusText: string
  progress: number
  error: string
}

export interface ConvertOptions {
  sourceDir: string
  bitrate: string
  overwrite?: boolean
}

export interface ConvertResult {
  outputDir: string
  finalOutputDir: string
  albumCountWarnings: string[]
  tasks: ConvertTask[]
}

export type FfmpegRunner = (ffmpegPath: string, args: string[], task: ConvertTask) => Promise<void>

export interface FlacConverterOptions {
  ffmpegPath?: string
  runner?: FfmpegRunner
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac'])

export class FlacConverter {
  private readonly ffmpegPath: string
  private readonly runner: FfmpegRunner
  private tasks: ConvertTask[] = []
  private outputDir = ''
  private finalOutputDir = ''
  private albumCountWarnings: string[] = []
  private cancelled = false
  private running = false

  constructor(options: FlacConverterOptions = {}) {
    this.ffmpegPath = options.ffmpegPath || resolveFfmpegPath()
    this.runner = options.runner || runFfmpeg
  }

  scan(sourceDir: string): ConvertTask[] {
    this.outputDir = resolveAutomaticOutputDir(sourceDir)
    this.finalOutputDir = this.outputDir
    this.albumCountWarnings = []
    this.tasks = scanFlacFiles(sourceDir)
    return this.list()
  }

  list(): ConvertTask[] {
    return this.tasks.map((task) => ({ ...task }))
  }

  result(): ConvertResult {
    return {
      outputDir: this.outputDir,
      finalOutputDir: this.finalOutputDir || this.outputDir,
      albumCountWarnings: [...this.albumCountWarnings],
      tasks: this.list(),
    }
  }

  cancel(): ConvertTask[] {
    this.cancelled = true
    for (const task of this.tasks) {
      if (task.status === 'waiting') {
        markTask(task, 'cancelled', '已取消')
      }
    }
    return this.list()
  }

  isRunning(): boolean {
    return this.running
  }

  async start(options: ConvertOptions): Promise<ConvertResult> {
    if (this.running) return this.result()
    this.cancelled = false
    this.running = true
    this.outputDir = resolveAutomaticOutputDir(options.sourceDir)
    this.finalOutputDir = this.outputDir
    this.albumCountWarnings = []
    this.tasks = scanFlacFiles(options.sourceDir)
    try {
      for (const task of this.tasks) {
        if (this.cancelled) {
          markTask(task, 'cancelled', '已取消')
          continue
        }
        await this.runTask(task, options)
      }
      if (!this.cancelled && fs.existsSync(this.outputDir)) {
        this.finalOutputDir = finalizeOutputFolder(this.outputDir)
        this.albumCountWarnings = renameAlbumFoldersUnderOutput(this.finalOutputDir)
      }
    } finally {
      this.running = false
    }
    return this.result()
  }

  private async runTask(task: ConvertTask, options: ConvertOptions): Promise<void> {
    if (!options.overwrite && fs.existsSync(task.outputPath)) {
      markTask(task, 'skipped', '已跳过')
      task.progress = 100
      return
    }

    markTask(task, 'running', task.kind === 'copy_mp3' ? '复制中' : '转换中')
    task.progress = 0
    fs.mkdirSync(path.dirname(task.outputPath), { recursive: true })

    try {
      if (task.kind === 'copy_mp3') {
        fs.copyFileSync(task.sourcePath, task.outputPath)
      } else {
        const args = buildFfmpegArgs(task.sourcePath, task.outputPath, options.bitrate, !!options.overwrite)
        await this.runner(this.ffmpegPath, args, task)
        validateDownloadedAudioFile(task.outputPath, 'mp3')
      }
      task.progress = 100
      markTask(task, 'success', task.kind === 'copy_mp3' ? '复制成功' : '转换成功')
    } catch (error) {
      if (fs.existsSync(task.outputPath)) fs.rmSync(task.outputPath, { force: true })
      task.progress = 0
      task.error = error instanceof Error ? error.message : String(error)
      markTask(task, 'failed', task.kind === 'copy_mp3' ? '复制失败' : '转换失败')
    }
  }
}

export function scanFlacFiles(sourceDir: string): ConvertTask[] {
  if (!fs.existsSync(sourceDir)) return []
  const outputDir = resolveAutomaticOutputDir(sourceDir)
  const tasks: ConvertTask[] = []
  walk(sourceDir, (filePath) => {
    const ext = path.extname(filePath).toLowerCase()
    if (!AUDIO_EXTENSIONS.has(ext)) return
    const kind: ConvertTaskKind = ext === '.mp3' ? 'copy_mp3' : 'flac_to_mp3'
    const relative = path.relative(sourceDir, filePath)
    const outputPath = kind === 'copy_mp3'
      ? path.join(outputDir, relative)
      : path.join(outputDir, relative).replace(/\.flac$/i, '.mp3')
    tasks.push({
      id: stableTaskId(filePath, outputPath),
      sourcePath: filePath,
      outputPath,
      kind,
      status: 'waiting',
      statusText: kind === 'copy_mp3' ? '等待复制' : '等待转换',
      progress: 0,
      error: '',
    })
  })
  return tasks
}

export function resolveAutomaticOutputDir(sourceDir: string): string {
  const parsed = path.parse(path.resolve(sourceDir))
  const baseName = `${stripSongCountSuffix(parsed.base)} MP3`
  const existing = findExistingOutputFolder(parsed.dir, baseName)
  return existing || path.join(parsed.dir, baseName)
}

export function buildFfmpegArgs(sourcePath: string, outputPath: string, bitrate: string, overwrite: boolean): string[] {
  return [
    overwrite ? '-y' : '-n',
    '-hide_banner',
    '-i',
    sourcePath,
    '-map',
    '0:a:0',
    '-map',
    '0:v?',
    '-map_metadata',
    '0',
    '-c:a',
    'libmp3lame',
    '-b:a',
    bitrate || '320k',
    '-c:v',
    'copy',
    '-id3v2_version',
    '3',
    outputPath,
  ]
}

export function resolveFfmpegPath(): string {
  const resourceRoot = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
  const resourceCandidate = process.platform === 'win32'
    ? path.join(resourceRoot, 'ffmpeg.exe')
    : path.join(resourceRoot, 'ffmpeg')
  if (isUsableBinary(resourceCandidate)) return resourceCandidate

  const assetCandidate = process.platform === 'win32'
    ? path.resolve(__dirname, '../../assets/ffmpeg.exe')
    : path.resolve(__dirname, '../../assets/ffmpeg')
  if (isUsableBinary(assetCandidate)) return assetCandidate

  try {
    const ffmpegStatic = require('ffmpeg-static') as string | null
    if (ffmpegStatic && isUsableBinary(ffmpegStatic)) return ffmpegStatic
  } catch {
    // Fallback to PATH when the packaged static binary is unavailable.
  }

  if (process.platform === 'win32') {
    const chocolateyCandidate = 'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe'
    if (isUsableBinary(chocolateyCandidate)) return chocolateyCandidate
  }

  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

function finalizeOutputFolder(outputDir: string): string {
  const totalSongs = countMp3Files(outputDir)
  const targetDir = path.join(path.dirname(outputDir), `${stripSongCountSuffix(path.basename(outputDir))}（${totalSongs}首）`)
  if (path.resolve(outputDir) === path.resolve(targetDir)) return outputDir
  if (fs.existsSync(targetDir)) throw new Error(`目标目录已存在：${targetDir}`)
  fs.renameSync(outputDir, targetDir)
  return targetDir
}

function renameAlbumFoldersUnderOutput(outputRoot: string): string[] {
  const warnings: string[] = []
  for (const folder of iterAlbumLeafDirs(outputRoot)) {
    const actualCount = countDirectMp3Files(folder)
    if (actualCount <= 0) continue
    const currentName = path.basename(folder)
    const declaredCount = readSongCountSuffix(currentName)
    const targetName = updateAlbumFolderCountInName(currentName, actualCount)
    if (currentName === targetName) continue
    const targetPath = path.join(path.dirname(folder), targetName)
    if (fs.existsSync(targetPath)) {
      if (declaredCount != null && declaredCount !== actualCount) {
        warnings.push(`专辑曲目数修正失败：${currentName} -> ${targetName}（目标目录已存在）`)
      }
      continue
    }
    fs.renameSync(folder, targetPath)
    if (declaredCount != null && declaredCount !== actualCount) {
      warnings.push(`专辑曲目数已修正：${currentName} -> ${targetName}`)
    }
  }
  return warnings
}

function iterAlbumLeafDirs(outputRoot: string): string[] {
  if (!fs.existsSync(outputRoot)) return []
  const folders: string[] = []
  walkDirs(outputRoot, (dirPath) => {
    if (path.resolve(dirPath) === path.resolve(outputRoot)) return
    if (countDirectMp3Files(dirPath) > 0) folders.push(dirPath)
  })
  return folders.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
}

function updateAlbumFolderCountInName(folderName: string, newCount: number): string {
  const match = folderName.match(/^(.*)\s*([（(])(\d+)首([）)])$/)
  if (!match) return `${folderName}（${newCount}首）`
  return `${match[1].trimEnd()}${match[2]}${newCount}首${match[4]}`
}

function readSongCountSuffix(folderName: string): number | null {
  const match = folderName.match(/[（(](\d+)首[）)]$/)
  return match ? Number(match[1]) : null
}

function stripSongCountSuffix(name: string): string {
  return name.replace(/[（(]\d+首[）)]$/, '').trim()
}

function findExistingOutputFolder(parentDir: string, baseName: string): string | null {
  if (!fs.existsSync(parentDir)) return null
  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (entry.isDirectory() && stripSongCountSuffix(entry.name) === baseName) {
      return path.join(parentDir, entry.name)
    }
  }
  return null
}

function countMp3Files(folderPath: string): number {
  let count = 0
  walk(folderPath, (filePath) => {
    if (path.extname(filePath).toLowerCase() === '.mp3') count += 1
  })
  return count
}

function countDirectMp3Files(folderPath: string): number {
  try {
    return fs.readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp3')
      .length
  } catch {
    return 0
  }
}

function runFfmpeg(ffmpegPath: string, args: string[], task: ConvertTask): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      task.statusText = '转换中'
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(compactFfmpegError(stderr, code, signal, ffmpegPath)))
    })
  })
}

function compactFfmpegError(stderr: string, code: number | null, signal: NodeJS.Signals | null, ffmpegPath: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const tail = lines.slice(-3).join(' | ')
  const normalizedCode = typeof code === 'number' && code > 0x7fffffff ? code - 0x100000000 : code
  const suffix = `ffmpeg=${ffmpegPath} exitCode=${normalizedCode ?? 'unknown'}${signal ? ` signal=${signal}` : ''}`
  return tail ? `${tail} | ${suffix}` : suffix
}

function walk(dir: string, visitor: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(fullPath, visitor)
    else if (entry.isFile()) visitor(fullPath)
  }
}

function walkDirs(dir: string, visitor: (dirPath: string) => void): void {
  visitor(dir)
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walkDirs(path.join(dir, entry.name), visitor)
  }
}

function stableTaskId(sourcePath: string, outputPath: string): string {
  return Buffer.from(`${sourcePath}\n${outputPath}`).toString('base64url')
}

function markTask(task: ConvertTask, status: ConvertStatus, statusText: string): void {
  task.status = status
  task.statusText = statusText
}

function isUsableBinary(filePath: string): boolean {
  try {
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) return false
    const result = spawnSync(filePath, ['-version'], { windowsHide: true, timeout: 5000 })
    return result.status === 0
  } catch {
    return false
  }
}
