import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FlacConverter,
  resolveAutomaticOutputDir,
  scanFlacFiles,
  type FfmpegRunner,
} from '../src/main/core/flacConverter'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function tempDir(): string {
  dir = join(tmpdir(), `easy-music-flac-converter-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeValidMp3(filePath: string): void {
  writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]))
}

describe('FLAC converter', () => {
  it('scans FLAC files recursively and mirrors output paths as MP3', () => {
    const root = tempDir()
    const source = join(root, 'Singer（2首）')
    mkdirSync(join(source, 'Album'), { recursive: true })
    writeFileSync(join(source, 'Album', '01. Song.flac'), 'flac')
    writeFileSync(join(source, 'Album', 'cover.jpg'), 'image')

    const tasks = scanFlacFiles(source)

    expect(tasks).toHaveLength(1)
    expect(tasks[0].sourcePath).toBe(join(source, 'Album', '01. Song.flac'))
    expect(tasks[0].outputPath).toBe(join(root, 'Singer MP3', 'Album', '01. Song.mp3'))
    expect(tasks[0].kind).toBe('flac_to_mp3')
  })

  it('copies MP3 files and resolves existing counted output folders', () => {
    const root = tempDir()
    const source = join(root, 'Singer（2首）')
    const output = join(root, 'Singer MP3（1首）')
    mkdirSync(join(source, 'Album'), { recursive: true })
    mkdirSync(output, { recursive: true })
    writeValidMp3(join(source, 'Album', '01. Song.mp3'))

    expect(resolveAutomaticOutputDir(source)).toBe(output)
    const tasks = scanFlacFiles(source)

    expect(tasks).toHaveLength(1)
    expect(tasks[0].kind).toBe('copy_mp3')
    expect(tasks[0].outputPath).toBe(join(output, 'Album', '01. Song.mp3'))
  })

  it('preserves metadata and embedded cover mapping when invoking ffmpeg', async () => {
    const root = tempDir()
    const source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'Song.flac'), 'fLaC')
    const calls: string[][] = []
    const runner: FfmpegRunner = async (_ffmpeg, args) => {
      calls.push(args)
      writeValidMp3(args[args.length - 1])
    }

    const converter = new FlacConverter({ ffmpegPath: 'ffmpeg-test', runner })
    const result = await converter.start({ sourceDir: source, bitrate: '320k', overwrite: true })
    const tasks = result.tasks

    expect(tasks[0].status).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(expect.arrayContaining(['-map_metadata', '0', '-map', '0:v?', '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3']))
  })

  it('skips existing MP3 files when overwrite is disabled', async () => {
    const root = tempDir()
    const source = join(root, 'source')
    const output = join(root, 'source MP3')
    mkdirSync(source, { recursive: true })
    mkdirSync(output, { recursive: true })
    writeFileSync(join(source, 'Song.flac'), 'fLaC')
    writeValidMp3(join(output, 'Song.mp3'))
    let called = false
    const runner: FfmpegRunner = async () => {
      called = true
    }

    const converter = new FlacConverter({ ffmpegPath: 'ffmpeg-test', runner })
    const result = await converter.start({ sourceDir: source, bitrate: '320k', overwrite: false })
    const tasks = result.tasks

    expect(called).toBe(false)
    expect(tasks[0].status).toBe('skipped')
  })

  it('marks failed conversion and removes invalid MP3 output', async () => {
    const root = tempDir()
    const source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'Song.flac'), 'fLaC')
    const runner: FfmpegRunner = async (_ffmpeg, args) => {
      writeFileSync(args[args.length - 1], 'not mp3')
    }

    const converter = new FlacConverter({ ffmpegPath: 'ffmpeg-test', runner })
    const result = await converter.start({ sourceDir: source, bitrate: '320k', overwrite: true })
    const tasks = result.tasks

    expect(tasks[0].status).toBe('failed')
    expect(tasks[0].error).toContain('MP3')
    expect(existsSync(join(root, 'source MP3', 'Song.mp3'))).toBe(false)
  })

  it('finalizes output folder and reports only mismatched album counts', async () => {
    const root = tempDir()
    const source = join(root, 'Singer（3首）')
    mkdirSync(join(source, '2025 Album（1首）'), { recursive: true })
    mkdirSync(join(source, 'No Count Album'), { recursive: true })
    writeFileSync(join(source, '2025 Album（1首）', '01. First.flac'), 'fLaC')
    writeFileSync(join(source, '2025 Album（1首）', '02. Second.flac'), 'fLaC')
    writeValidMp3(join(source, 'No Count Album', '03. Third.mp3'))
    const runner: FfmpegRunner = async (_ffmpeg, args) => {
      writeValidMp3(args[args.length - 1])
    }

    const converter = new FlacConverter({ ffmpegPath: 'ffmpeg-test', runner })
    const result = await converter.start({ sourceDir: source, bitrate: '320k', overwrite: true })

    expect(result.outputDir).toBe(join(root, 'Singer MP3'))
    expect(result.finalOutputDir).toBe(join(root, 'Singer MP3（3首）'))
    expect(existsSync(join(result.finalOutputDir, '2025 Album（2首）'))).toBe(true)
    expect(existsSync(join(result.finalOutputDir, 'No Count Album（1首）'))).toBe(true)
    expect(result.albumCountWarnings).toEqual([
      expect.stringContaining('2025 Album（1首） -> 2025 Album（2首）'),
    ])
  })

  it('reports album count rename conflicts without overwriting folders', async () => {
    const root = tempDir()
    const source = join(root, 'Singer')
    mkdirSync(join(source, 'Album（1首）'), { recursive: true })
    mkdirSync(join(source, 'Album（2首）'), { recursive: true })
    writeValidMp3(join(source, 'Album（1首）', '01. First.mp3'))
    writeValidMp3(join(source, 'Album（1首）', '02. Second.mp3'))
    writeValidMp3(join(source, 'Album（2首）', 'existing.mp3'))

    const converter = new FlacConverter({ ffmpegPath: 'ffmpeg-test' })
    const result = await converter.start({ sourceDir: source, bitrate: '320k', overwrite: true })

    expect(existsSync(join(result.finalOutputDir, 'Album（1首）'))).toBe(true)
    expect(result.albumCountWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('目标目录已存在'),
    ]))
  })
})
