import { describe, expect, it, vi } from 'vitest'
import { buildEasyMusicDebugSnapshot } from '../tools/debug/export-easy-music-info'

describe('debug music info tools', () => {
  it('exports easy-music LX musicInfo snapshots for each Kugou quality', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('song_search_v2')) {
        return new Response(JSON.stringify({
          data: {
            lists: [{
              Audioid: 22113473,
              SongName: '造物者',
              SingerName: '华晨宇',
              AlbumID: 100,
              AlbumName: '造物者',
              Duration: 191,
              FileHash: 'hash-128',
              HQFileHash: 'hash-320',
              SQFileHash: 'hash-flac',
              FileSize: 1,
              HQFileSize: 2,
              SQFileSize: 3,
            }],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const snapshot = await buildEasyMusicDebugSnapshot({
      query: '造物者 华晨宇',
      title: '造物者',
      artist: '华晨宇',
      album: '造物者',
      platform: 'kg',
      qualities: ['flac', '320k', '128k'],
      limit: 20,
    })

    expect(snapshot.selectedSong).toMatchObject({
      platform: 'kg',
      platformSongId: '22113473',
      title: '造物者',
      artist: '华晨宇',
      albumName: '造物者',
    })
    expect(snapshot.attempts.map((attempt) => [attempt.quality, attempt.musicId, attempt.musicInfo.hash, (attempt.musicInfo.meta as any).audioId])).toEqual([
      ['flac', 'hash-128', 'hash-128', 22113473],
      ['320k', 'hash-128', 'hash-128', 22113473],
      ['128k', 'hash-128', 'hash-128', 22113473],
    ])
    expect((snapshot.attempts[0].musicInfo as any)._types.flac.hash).toBe('hash-flac')
    expect((snapshot.attempts[0].musicInfo as any)._types['320k'].hash).toBe('hash-320')
  })
})
