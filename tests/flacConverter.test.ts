import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FlacConverter, scanFlacFiles, type FfmpegRunner } from '../src/main/core/flacConverter'

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
    const source = join(root, 'source')
    const output = join(root, 'output')
    mkdirSync(join(source, 'Album'), { recursive: true })
    writeFileSync(join(source, 'Album', '01. Song.flac'), 'flac')
    writeFileSync(join(source, 'Album', 'cover.jpg'), 'image')

    const tasks = scanFlacFiles(source, output)

    expect(tasks).toHaveLength(1)
    expect(tasks[0].sourcePath).toBe(join(source, 'Album', '01. Song.flac'))
    expect(tasks[0].outputPath).toBe(join(output, 'Album', '01. Song.mp3'))
  })

  it('preserves metadata and embedded cover mapping when invoking ffmpeg', async () => {
    const root = tempDir()
    const source = join(root, 'source')
    const output = join(root, 'output')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'Song.flac'), 'fLaC')
    const calls: string[][] = []
    const runner: FfmpegRunner = async (_ffmpeg, args) => {
      calls.push(args)
      writeValidMp3(args[args.length - 1])
    }

    const converter = new FlacConverter({ ffmpegPath: 'ffmpeg-test', runner })
    const tasks = await converter.start({ sourceDir: source, outputDir: output, bitrate: '320k', overwrite: true })

    expect(tasks[0].status).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(expect.arrayContaining(['-map_metadata', '0', '-map', '0:v?', '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3']))
  })

  it('skips existing MP3 files when overwrite is disabled', async () => {
    const root = tempDir()
    const source = join(root, 'source')
    const output = join(root, 'output')
    mkdirSync(source, { recursive: true })
    mkdirSync(output, { recursive: true })
    writeFileSync(join(source, 'Song.flac'), 'fLaC')
    writeValidMp3(join(output, 'Song.mp3'))
    let called = false
    const runner: FfmpegRunner = async () => {
      called = true
    }

    const converter = new FlacConverter({ ffmpegPath: 'ffmpeg-test', runner })
    const tasks = await converter.start({ sourceDir: source, outputDir: output, bitrate: '320k', overwrite: false })

    expect(called).toBe(false)
    expect(tasks[0].status).toBe('skipped')
  })

  it('marks failed conversion and removes invalid MP3 output', async () => {
    const root = tempDir()
    const source = join(root, 'source')
    const output = join(root, 'output')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'Song.flac'), 'fLaC')
    const runner: FfmpegRunner = async (_ffmpeg, args) => {
      writeFileSync(args[args.length - 1], 'not mp3')
    }

    const converter = new FlacConverter({ ffmpegPath: 'ffmpeg-test', runner })
    const tasks = await converter.start({ sourceDir: source, outputDir: output, bitrate: '320k', overwrite: true })

    expect(tasks[0].status).toBe('failed')
    expect(tasks[0].error).toContain('MP3')
    expect(existsSync(join(output, 'Song.mp3'))).toBe(false)
  })
})
