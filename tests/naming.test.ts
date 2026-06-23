import { describe, expect, it } from 'vitest'
import { buildAlbumFolderName, resolveSongFilePath } from '../src/main/core/naming'
import type { Song } from '../src/main/core/types'

describe('download naming', () => {
  it('uses playlist artist folder and album folder without fixed counts before download finishes', () => {
    expect(
      resolveSongFilePath('D:/Music', 'Singer', song(), 'flac', {
        publishDate: '2025-01-10',
        albumSongCount: 99,
      }),
    ).toBe('D:\\Music\\Singer\\2025-01-10 Album\\01. Song.flac')
  })

  it('sanitizes album folder while preserving release date and actual count', () => {
    expect(buildAlbumFolderName('A/B:Album*', '2024-06-01', 3)).toBe('2024-06-01 A_B_Album_ (3首)')
  })
})

function song(): Song {
  return {
    id: 'kw:1',
    platform: 'kw',
    platformSongId: '1',
    title: 'Song',
    artist: 'Singer & Other',
    albumId: 'a1',
    albumName: 'Album',
    duration: 180,
    trackNo: 1,
    qualitys: ['flac'],
    raw: {},
  }
}
