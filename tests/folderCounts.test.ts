import { afterEach, describe, expect, it, vi } from 'vitest'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeSelectedArtistFolders, scanArtistFolders } from '../src/main/core/folderCounts'

const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x0f, 0xf0, 0x00, 0x00, 0x69, 0x00, 0x00])
const FLAC_BYTES = Buffer.from('fLaCminimal-audio-data')

describe('folder organizer', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('scans direct artist folders that contain flac or mp3 files', () => {
    const root = tempDir()
    writeFile(join(root, 'Singer', 'Album', '01. Song.flac'), FLAC_BYTES)
    writeFile(join(root, 'No Audio', 'Album', 'cover.jpg'), 'cover')

    const result = scanArtistFolders(root)

    expect(result.root).toBe(root)
    expect(result.items.map((item) => item.name)).toEqual(['Singer'])
    expect(result.items[0]).toMatchObject({
      path: join(root, 'Singer'),
      songCount: 1,
      needsRename: true,
    })
    expect(result.items[0].targetName).toContain('Singer')
    expect(result.items[0].targetName).toContain('1')
  })

  it('normalizes only selected artist folders and preserves unselected folders', () => {
    const root = tempDir()
    const singerAlbum = join(root, 'Singer', '2025-01-10 Album')
    writeFile(join(singerAlbum, '01. Song.flac'), FLAC_BYTES)
    writeFile(join(singerAlbum, '02. Existing.mp3'), MP3_BYTES)
    writeFile(join(singerAlbum, 'stale.flac.lxmtemp'), FLAC_BYTES)
    writeFile(join(singerAlbum, 'cover.jpg'), 'cover')
    writeFile(join(singerAlbum, 'demo.m4a'), 'm4a')
    writeFile(join(root, 'Other', 'Album', '01. Keep.mp3'), MP3_BYTES)
    writeFile(join(root, 'Other', 'Album', 'cover.jpg'), 'cover')

    const result = normalizeSelectedArtistFolders(root, ['Singer'])

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      originalName: 'Singer',
      songCount: 2,
      renamed: true,
    })
    expect(existsSync(join(root, 'Singer'))).toBe(false)
    expect(existsSync(result.items[0].path)).toBe(true)
    const [normalizedAlbumName] = readdirSync(result.items[0].path)
    const normalizedAlbumDir = join(result.items[0].path, normalizedAlbumName)
    expect(normalizedAlbumName).toContain('2025-01-10 Album')
    expect(normalizedAlbumName).toContain('2')
    expect(readdirSync(normalizedAlbumDir).sort()).toEqual(['01. Song.flac', '02. Existing.mp3'])
    expect(existsSync(join(root, 'Other', 'Album', 'cover.jpg'))).toBe(true)
  })

  it('reports duplicate track numbers in album folders', () => {
    const root = tempDir()
    writeFile(join(root, 'Singer', 'Album', '01. First.flac'), FLAC_BYTES)
    writeFile(join(root, 'Singer', 'Album', '01. Duplicate.mp3'), MP3_BYTES)

    const scan = scanArtistFolders(root)
    const result = normalizeSelectedArtistFolders(root, ['Singer'])

    expect(scan.items[0].warnings.join('\n')).toContain('01')
    expect(result.items[0].warnings.join('\n')).toContain('01')
  })

  it('adds folder context when manual normalization fails', () => {
    const root = tempDir()
    writeFile(join(root, 'Singer', 'Album', '01. Song.flac'), FLAC_BYTES)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename locked')
    })

    expect(() => normalizeSelectedArtistFolders(root, ['Singer'])).toThrow(/文件夹整理失败/)
    expect(() => normalizeSelectedArtistFolders(root, ['Singer'])).toThrow(/父目录：/)
    expect(() => normalizeSelectedArtistFolders(root, ['Singer'])).toThrow(/歌手文件夹：Singer/)
    expect(() => normalizeSelectedArtistFolders(root, ['Singer'])).toThrow(/步骤：/)
    expect(() => normalizeSelectedArtistFolders(root, ['Singer'])).toThrow(/rename locked/)
  })

  it('retries transient Windows rename locks while normalizing folders', () => {
    const root = tempDir()
    writeFile(join(root, 'Singer', 'Album', '01. Song.flac'), FLAC_BYTES)
    const realRenameSync = fs.renameSync
    let attempts = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('temporary lock') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return realRenameSync(from, to)
    })

    const result = normalizeSelectedArtistFolders(root, ['Singer'])

    expect(attempts).toBe(4)
    expect(result.items[0]).toMatchObject({ originalName: 'Singer', renamed: true })
    expect(existsSync(result.items[0].path)).toBe(true)
  })

  it('moves folder contents when the final artist folder rename remains locked', () => {
    const root = tempDir()
    writeFile(join(root, 'Singer', 'Album', '01. Song.flac'), FLAC_BYTES)
    const realRenameSync = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === join(root, 'Singer') && String(to).includes('Singer')) {
        const error = new Error('artist folder locked') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return realRenameSync(from, to)
    })

    const result = normalizeSelectedArtistFolders(root, ['Singer'])

    expect(result.items[0]).toMatchObject({ originalName: 'Singer', songCount: 1, renamed: true })
    expect(existsSync(result.items[0].path)).toBe(true)
    expect(existsSync(join(result.items[0].path, 'Album (1首)', '01. Song.flac'))).toBe(true)
    expect(existsSync(join(root, 'Singer'))).toBe(false)
  })

  it('keeps the normalized target when the emptied source folder cannot be removed immediately', () => {
    const root = tempDir()
    writeFile(join(root, 'Singer', 'Album', '01. Song.flac'), FLAC_BYTES)
    const realRenameSync = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === join(root, 'Singer') && String(to).includes('Singer')) {
        const error = new Error('artist folder locked') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return realRenameSync(from, to)
    })
    vi.spyOn(fs, 'rmdirSync').mockImplementation((dir) => {
      if (String(dir) === join(root, 'Singer')) {
        const error = new Error('source folder still open') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return undefined
    })

    const result = normalizeSelectedArtistFolders(root, ['Singer'])

    expect(result.items[0]).toMatchObject({ originalName: 'Singer', songCount: 1, renamed: true })
    expect(existsSync(result.items[0].path)).toBe(true)
    expect(existsSync(join(result.items[0].path, 'Album (1首)', '01. Song.flac'))).toBe(true)
    expect(readdirSync(join(root, 'Singer'))).toEqual([])
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'easy-music-folders-'))
    tempDirs.push(dir)
    return dir
  }

  function writeFile(filePath: string, data: string | Buffer): void {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, data)
  }
})
