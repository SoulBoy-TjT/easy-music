import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { validateDownloadedAudioFile } from './audioValidation'

export type ConvertStatus = 'waiting' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'

export interface ConvertTask {
  id: string
  sourcePath: string
  outputPath: string
  status: ConvertStatus
  statusText: string
  progress: number
  error: string
}

export interface ConvertOptions {
  sourceDir: string
  outputDir: string
  bitrate: string
  overwrite?: boolean
}

export type FfmpegRunner = (ffmpegPath: string, args: string[], task: ConvertTask) => Promise<void>

export interface FlacConverterOptions {
  ffmpegPath?: string
  runner?: FfmpegRunner
}

export class FlacConverter {
  private readonly ffmpegPath: string
  private readonly runner: FfmpegRunner
  private tasks: ConvertTask[] = []
  private cancelled = false
  private running = false

  constructor(options: FlacConverterOptions = {}) {
    this.ffmpegPath = options.ffmpegPath || resolveFfmpegPath()
    this.runner = options.runner || runFfmpeg
  }

  scan(sourceDir: string, outputDir: string): ConvertTask[] {
    this.tasks = scanFlacFiles(sourceDir, outputDir)
    return this.list()
  }

  list(): ConvertTask[] {
    return this.tasks.map((task) => ({ ...task }))
  }

  cancel(): ConvertTask[] {
    this.cancelled = true
    for (const task of this.tasks) {
      if (task.status === 'waiting') {
        task.status = 'cancelled'
        task.statusText = '已取消'
      }
    }
    return this.list()
  }

  isRunning(): boolean {
    return this.running
  }

  async start(options: ConvertOptions): Promise<ConvertTask[]> {
    if (this.running) return this.list()
    this.cancelled = false
    this.running = true
    this.tasks = scanFlacFiles(options.sourceDir, options.outputDir)
    try {
      for (const task of this.tasks) {
        if (this.cancelled) {
          markTask(task, 'cancelled', '已取消')
          continue
        }
        await this.runTask(task, options)
      }
    } finally {
      this.running = false
    }
    return this.list()
  }

  private async runTask(task: ConvertTask, options: ConvertOptions): Promise<void> {
    if (!options.overwrite && fs.existsSync(task.outputPath)) {
      markTask(task, 'skipped', '已跳过')
      task.progress = 100
      return
    }

    markTask(task, 'running', '转换中')
    task.progress = 0
    fs.mkdirSync(path.dirname(task.outputPath), { recursive: true })
    const args = buildFfmpegArgs(task.sourcePath, task.outputPath, options.bitrate, !!options.overwrite)

    try {
      await this.runner(this.ffmpegPath, args, task)
      validateDownloadedAudioFile(task.outputPath, 'mp3')
      task.progress = 100
      markTask(task, 'success', '转换成功')
    } catch (error) {
      if (fs.existsSync(task.outputPath)) fs.rmSync(task.outputPath, { force: true })
      task.progress = 0
      task.error = error instanceof Error ? error.message : String(error)
      markTask(task, 'failed', '转换失败')
    }
  }
}

export function scanFlacFiles(sourceDir: string, outputDir: string): ConvertTask[] {
  if (!fs.existsSync(sourceDir)) return []
  const tasks: ConvertTask[] = []
  walk(sourceDir, (filePath) => {
    if (path.extname(filePath).toLowerCase() !== '.flac') return
    const relative = path.relative(sourceDir, filePath)
    const outputPath = path.join(outputDir, relative).replace(/\.flac$/i, '.mp3')
    tasks.push({
      id: stableTaskId(filePath, outputPath),
      sourcePath: filePath,
      outputPath,
      status: 'waiting',
      statusText: '等待转换',
      progress: 0,
      error: '',
    })
  })
  return tasks
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

  try {
    const ffmpegStatic = require('ffmpeg-static') as string | null
    if (ffmpegStatic && isUsableBinary(ffmpegStatic)) return ffmpegStatic
  } catch {
    // Fallback to PATH when the packaged static binary is unavailable.
  }

  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
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
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(compactFfmpegError(stderr, code)))
    })
  })
}

function compactFfmpegError(stderr: string, code: number | null): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const tail = lines.slice(-3).join('；')
  return tail || `ffmpeg 退出码 ${code ?? '未知'}`
}

function walk(dir: string, visitor: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(fullPath, visitor)
    else if (entry.isFile()) visitor(fullPath)
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
    return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).size > 0
  } catch {
    return false
  }
}
