import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchArtistPlatformAlbums,
  resetPlatformFetchRuntimeForTests,
  searchPlatformSongs,
  selectBestAttempt,
  setPlatformFetchRuntimeForTests,
} from '../src/main/platforms'

describe('platform album fetching', () => {
  beforeEach(() => {
    setPlatformFetchRuntimeForTests({
      sleep: async () => {},
      randomInt: (min) => min,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetPlatformFetchRuntimeForTests()
  })

  it('selects the last consistent attempt and the largest inconsistent attempt', () => {
    const one = [album('kg', 'one')]
    const twoA = [album('kg', 'two-a'), album('kg', 'two-b')]
    const twoB = [album('kg', 'two-c'), album('kg', 'two-d')]

    expect(selectBestAttempt([
      { albums: one },
      { albums: one },
      { albums: twoA },
    ]).albums).toBe(twoA)
    expect(selectBestAttempt([
      { albums: one },
      { albums: twoA },
      { albums: twoB },
    ]).albums).toBe(twoB)
    expect(selectBestAttempt([
      { error: new Error('timeout') },
      { albums: one },
      { albums: twoA },
    ]).albums).toBe(twoA)
  })

  it('uses a single platform attempt when the first result is normal', async () => {
    const sleeps: number[] = []
    setPlatformFetchRuntimeForTests({
      sleep: async (ms) => { sleeps.push(ms) },
      randomInt: (min) => min,
    })
    let active = 0
    let maxActive = 0
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const url = new URL(String(input))
      calls.push(`${url.hostname}${url.pathname}`)
      await Promise.resolve()
      active -= 1
      if (url.hostname.includes('search.kuwo.cn')) {
        return jsonResponse({
          TOTAL: '1',
          abslist: [{
            MUSICRID: `MUSIC_${calls.length}`,
            SONGNAME: `Song ${calls.length}`,
            ARTIST: 'Singer',
            ALBUM: `Album ${calls.length}`,
            ALBUMID: `album-${calls.length}`,
            DURATION: '180',
          }],
        })
      }
      return jsonResponse({})
    }))
    const messages: string[] = []

    const result = await fetchArtistPlatformAlbums('Singer', (progress) => {
      if (progress.platform === 'kw') messages.push(progress.message)
    }, { platforms: ['kw'] })

    expect(result.kw).toHaveLength(1)
    expect(calls.filter((call) => call.includes('search.kuwo.cn'))).toHaveLength(2)
    expect(maxActive).toBe(1)
    expect(sleeps).toEqual([])
    expect(messages.some((message) => message.includes('2/3'))).toBe(false)
    expect(messages.length).toBeGreaterThan(0)
  })

  it('adds supplement attempts when the first result is clearly below the local album count', async () => {
    const sleeps: number[] = []
    setPlatformFetchRuntimeForTests({
      sleep: async (ms) => { sleeps.push(ms) },
      randomInt: (min) => min,
    })
    let attempt = 0
    const messages: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname.includes('search.kuwo.cn') && url.searchParams.get('stype') === 'albuminfo') return jsonResponse({})
      if (url.hostname.includes('search.kuwo.cn') && url.searchParams.has('all')) {
        if (url.searchParams.get('pn') === '0') attempt += 1
        const count = attempt === 1 ? 1 : 6
        return jsonResponse({
          TOTAL: String(count),
          abslist: Number(url.searchParams.get('pn') || 0) === 0 ? kuwoSongs(String(attempt), count) : [],
        })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', (progress) => {
      if (progress.platform === 'kw') messages.push(progress.message)
    }, { platforms: ['kw'], expectedAlbumCounts: { kw: 6 } })

    expect(result.kw).toHaveLength(6)
    expect(attempt).toBe(2)
    expect(sleeps).toEqual([2000])
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.some((message) => message.includes('1 / 6'))).toBe(true)
  })

  it('adds cache busting and no-cache headers to Kugou album list requests', async () => {
    setPlatformFetchRuntimeForTests({
      sleep: async () => {},
      randomInt: (min) => min,
    })
    const albumListRequests: Array<{ url: URL; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/api/v3/search/singer')) {
        return jsonResponse({ data: { info: [{ singername: 'Singer', singerid: 99 }] } })
      }
      if (url.pathname.includes('/api/v5/singer/album')) {
        albumListRequests.push({ url, init })
        return jsonResponse({ data: { total: 1, info: [{ albumid: 11, albumname: 'Album', publishtime: '2024-01-01', songcount: 1 }] } })
      }
      if (url.pathname.includes('/api/v3/album/song')) {
        return jsonResponse({ data: { info: [{ hash: 'hash-1', songname: 'Song', singername: 'Singer', duration: 180 }] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['kg'] })

    expect(result.kg).toHaveLength(1)
    expect(albumListRequests).toHaveLength(1)
    expect(albumListRequests.every((request) => request.url.searchParams.has('_'))).toBe(true)
    expect(albumListRequests.every((request) => {
      const headers = request.init?.headers as Record<string, string>
      return headers?.['Cache-Control'] === 'no-cache' && headers?.Pragma === 'no-cache'
    })).toBe(true)
  })

  it('limits Kugou album detail requests to two concurrent requests', async () => {
    let activeAlbumDetails = 0
    let maxAlbumDetails = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/api/v3/search/singer')) {
        return jsonResponse({ data: { info: [{ singername: 'Singer', singerid: 99 }] } })
      }
      if (url.pathname.includes('/api/v5/singer/album')) {
        return jsonResponse({
          data: {
            total: 4,
            info: Array.from({ length: 4 }, (_, index) => ({
              albumid: 100 + index,
              albumname: `Album ${index}`,
              publishtime: '2024-01-01',
              songcount: 1,
            })),
          },
        })
      }
      if (url.pathname.includes('/api/v3/album/song')) {
        activeAlbumDetails += 1
        maxAlbumDetails = Math.max(maxAlbumDetails, activeAlbumDetails)
        await Promise.resolve()
        activeAlbumDetails -= 1
        return jsonResponse({ data: { info: [{ hash: `hash-${url.searchParams.get('albumid')}`, songname: 'Song', singername: 'Singer', duration: 180 }] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['kg'] })

    expect(result.kg).toHaveLength(4)
    expect(maxAlbumDetails).toBe(2)
  })

  it('maps Kugou search results into downloadable songs with ids and hashes', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('song_search_v2')) {
        return jsonResponse({
          data: {
            lists: [{
              Audioid: 22146367,
              SongName: 'Here We Are',
              Singers: [{ name: 'Singer' }],
              AlbumID: 7788,
              AlbumName: 'Target Album',
              Duration: 290,
              FileHash: 'hash-128',
              HQFileHash: 'hash-320',
              SQFileHash: 'hash-flac',
              ResFileHash: 'hash-hires',
              FileSize: 1,
              HQFileSize: 2,
              SQFileSize: 3,
              ResFileSize: 4,
            }],
          },
        })
      }
      return jsonResponse({})
    }))

    const songs = await searchPlatformSongs('Here We Are Singer Target Album', ['kg'], 20)

    expect(urls[0]).toContain('song_search_v2')
    expect(songs).toHaveLength(1)
    expect(songs[0]).toMatchObject({
      platform: 'kg',
      platformSongId: '22146367',
      title: 'Here We Are',
      artist: 'Singer',
      albumName: 'Target Album',
      qualitys: ['flac24bit', 'flac', '320k', '128k'],
    })
    expect(songs[0].raw).toMatchObject({
      hash: 'hash-128',
      '320hash': 'hash-320',
      sqhash: 'hash-flac',
      hash_high: 'hash-hires',
      audio_id: 22146367,
    })
  })

  it('keeps search results from other platforms when one platform search fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('client_search_cp')) {
        return new Response('server error', { status: 500 })
      }
      if (url.includes('song_search_v2')) {
        return jsonResponse({
          data: {
            lists: [{
              Audioid: 83525,
              SongName: 'Ordinary Life',
              SingerName: 'Singer',
              AlbumName: 'Ordinary Life',
              Duration: 261,
              FileHash: 'kg-hash',
              HQFileHash: 'kg-320',
              FileSize: 1,
              HQFileSize: 2,
            }],
          },
        })
      }
      return jsonResponse({})
    }))

    const songs = await searchPlatformSongs('Ordinary Life Singer Ordinary Life', ['kg', 'tx'], 20)

    expect(songs).toHaveLength(1)
    expect(songs[0]).toMatchObject({
      platform: 'kg',
      platformSongId: '83525',
      title: 'Ordinary Life',
      artist: 'Singer',
      albumName: 'Ordinary Life',
    })
  })

  it('uses QQ album pages and album detail songs instead of singer song aggregation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('smartbox_new.fcg')) {
        return jsonResponse({ code: 0, data: { singer: { itemlist: [{ mid: 'singer-mid', name: 'Singer' }] } } })
      }
      if (url.includes('musicu.fcg')) {
        const body = parseMusicuPayload(url, init)
        if (body.singerAlbum) {
          return jsonResponse({
            code: 0,
            singerAlbum: {
              data: {
                total: 2,
                list: [
                  { album_mid: 'album-a', album_name: 'Album A', publish_time: '2024-01-01', song_count: 2 },
                  { album_mid: 'album-b', album_name: 'Album B', publish_time: '2024-02-01', song_count: 1 },
                ],
              },
            },
          })
        }
        if (body.albumSonglist?.param?.albumMid === 'album-a') {
          return jsonResponse({ code: 0, albumSonglist: { data: { totalNum: 2, songList: [
            qqSong('song-a1', 'Song A1', 'album-a', 'Album A'),
            qqSong('song-a2', 'Song A2', 'album-a', 'Album A'),
          ] } } })
        }
        if (body.albumSonglist?.param?.albumMid === 'album-b') {
          return jsonResponse({ code: 0, albumSonglist: { data: { totalNum: 1, songList: [
            qqSong('song-b1', 'Song B1', 'album-b', 'Album B'),
          ] } } })
        }
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer')

    expect(result.tx).toHaveLength(2)
    expect(result.tx.flatMap((album) => album.songs)).toHaveLength(3)
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => {
      if (!String(url).includes('musicu.fcg')) return false
      const body = parseMusicuPayload(String(url), init as RequestInit | undefined)
      return body.req?.method === 'GetSingerSongList'
    })).toBe(false)
  })

  it('uses the legacy QQ musicu GET data payload from the previous downloader', async () => {
    const musicuCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('smartbox_new.fcg')) {
        return jsonResponse({ code: 0, data: { singer: { itemlist: [{ mid: 'singer-mid', name: 'Singer' }] } } })
      }
      if (url.includes('musicu.fcg')) {
        musicuCalls.push(url)
        expect(init?.method || 'GET').toBe('GET')
        const body = parseMusicuPayload(url, init)
        if (body.singerAlbum) {
          return jsonResponse({ singerAlbum: { data: { total: 1, list: [{ album_mid: 'album-a', album_name: 'Album A', song_count: 1 }] } } })
        }
        return jsonResponse({ albumSonglist: { data: { totalNum: 1, songList: [qqSong('song-a1', 'Song A1', 'album-a', 'Album A')] } } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer')

    expect(result.tx.flatMap((album) => album.songs)).toHaveLength(1)
    expect(musicuCalls.every((url) => new URL(url).searchParams.has('data'))).toBe(true)
  })

  it('keeps QQ per-song artist names instead of replacing them with the requested artist', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('smartbox_new.fcg')) {
        return jsonResponse({ code: 0, data: { singer: { itemlist: [{ mid: 'penny-mid', name: 'Penny' }] } } })
      }
      if (url.includes('musicu.fcg')) {
        const body = parseMusicuPayload(url, init)
        if (body.singerAlbum) {
          return jsonResponse({ singerAlbum: { data: { total: 1, list: [{ album_mid: 'album-a', album_name: 'OST Album', song_count: 2 }] } } })
        }
        return jsonResponse({ albumSonglist: { data: { totalNum: 2, songList: [
          qqSong('song-a1', 'Keep', 'album-a', 'OST Album', [{ name: 'Penny', mid: 'penny-mid' }]),
          qqSong('song-a2', 'Drop', 'album-a', 'OST Album', [{ name: 'Other Singer', mid: 'other-mid' }]),
        ] } } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Penny', undefined, { platforms: ['tx'] })

    expect(result.tx).toHaveLength(1)
    expect(result.tx[0].songs).toHaveLength(1)
    expect(result.tx[0].songs[0]).toMatchObject({
      title: 'Keep',
      artist: 'Penny',
    })
    expect(result.tx[0].songCount).toBe(1)
  })

  it('keeps songs when the platform artist name prefixes the requested Chinese name with a Latin alias', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v3/search/singer')) {
        return jsonResponse({ data: { info: [{ singername: 'Eric周兴哲', singerid: 169235 }] } })
      }
      if (url.includes('/api/v5/singer/album')) {
        return jsonResponse({ data: { total: 1, info: [{ albumid: 11, albumname: '想念你想我', publishtime: '2024-01-01', songcount: 1 }] } })
      }
      if (url.includes('/api/v3/album/song')) {
        return jsonResponse({ data: { info: [{ filename: 'Eric周兴哲 - 想念你想我', hash: 'hash-1', duration: 180 }] } })
      }
      if (url.includes('smartbox_new.fcg')) {
        return jsonResponse({ code: 0, data: { singer: { itemlist: [{ mid: 'eric-mid', name: 'Eric周兴哲' }] } } })
      }
      if (url.includes('musicu.fcg')) {
        const body = parseMusicuPayload(url, init)
        if (body.singerAlbum) {
          return jsonResponse({ singerAlbum: { data: { total: 1, list: [{ album_mid: 'album-a', album_name: '想念你想我', song_count: 1 }] } } })
        }
        return jsonResponse({ albumSonglist: { data: { totalNum: 1, songList: [
          qqSong('song-a1', '想念你想我', 'album-a', '想念你想我', [{ name: 'Eric周兴哲', mid: 'eric-mid' }]),
        ] } } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('周兴哲', undefined, { platforms: ['kg', 'tx'] })

    expect(result.kg).toHaveLength(1)
    expect(result.kg[0].songs).toHaveLength(1)
    expect(result.tx).toHaveLength(1)
    expect(result.tx[0].songs).toHaveLength(1)
  })

  it('retries Kuwo search with a platform alias when the requested Chinese name returns no songs', async () => {
    const kuwoQueries: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname.includes('search.kuwo.cn') && url.searchParams.get('stype') === 'albuminfo') {
        return jsonResponse({})
      }
      if (url.hostname.includes('search.kuwo.cn')) {
        const query = url.searchParams.get('all') || ''
        kuwoQueries.push(query)
        if (query === '周兴哲') return jsonResponse({ TOTAL: '0', abslist: [] })
        if (query === 'Eric周兴哲') {
          return jsonResponse({ TOTAL: '1', abslist: [{
            MUSICRID: 'MUSIC_1',
            SONGNAME: '想念你想我',
            ARTIST: 'Eric周兴哲',
            ALBUM: '想念你想我',
            ALBUMID: 'album-a',
            DURATION: '180',
          }] })
        }
      }
      if (url.hostname.includes('c.y.qq.com')) {
        return jsonResponse({ code: 0, data: { singer: { itemlist: [{ mid: 'eric-mid', name: 'Eric周兴哲' }] } } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('周兴哲', undefined, { platforms: ['kw'] })

    expect(kuwoQueries).toContain('周兴哲')
    expect(kuwoQueries).toContain('Eric周兴哲')
    expect(result.kw).toHaveLength(1)
    expect(result.kw[0].songs).toHaveLength(1)
  })

  it('keeps partial Kuwo albums when a later search page is rate limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname.includes('search.kuwo.cn') && url.searchParams.get('stype') === 'albuminfo') {
        return jsonResponse({})
      }
      if (url.hostname.includes('search.kuwo.cn')) {
        const page = Number(url.searchParams.get('pn') || 0)
        if (page === 0) {
          return jsonResponse({ TOTAL: '100', abslist: Array.from({ length: 50 }, (_, index) => ({
            MUSICRID: `MUSIC_${index}`,
            SONGNAME: `想念你想我 ${index}`,
            ARTIST: 'Eric周兴哲',
            ALBUM: '想念你想我',
            ALBUMID: 'album-a',
            DURATION: '180',
          })) })
        }
        return new Response('<html>rate limited</html>', { status: 403 })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('周兴哲', undefined, { platforms: ['kw'] })

    expect(result.kw).toHaveLength(1)
    expect(result.kw[0].songs).toHaveLength(50)
  })

  it('keeps fetching Kuwo search pages until the old tool page limit or an empty page', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname.includes('search.kuwo.cn')) {
        const page = Number(url.searchParams.get('pn') || 0)
        if (page < 10) {
          return jsonResponse({
            TOTAL: '500',
            abslist: Array.from({ length: 50 }, (_, index) => ({
              MUSICRID: `MUSIC_${page}-${index}`,
              SONGNAME: `Song ${page}-${index}`,
              ARTIST: 'Singer',
              ALBUM: `Album ${page}-${index}`,
              ALBUMID: `album-${page}-${index}`,
              DURATION: '180',
            })),
          })
        }
        return jsonResponse({ TOTAL: '500', abslist: [] })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer')

    expect(result.kw.flatMap((album) => album.songs)).toHaveLength(500)
  })

  it('retries transient empty Kuwo pages when totals indicate more data', async () => {
    let secondPageAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname.includes('search.kuwo.cn')) {
        const page = Number(url.searchParams.get('pn') || 0)
        if (page === 0) return jsonResponse({ TOTAL: '100', abslist: kuwoSongs('0', 50) })
        if (page === 1) {
          secondPageAttempts += 1
          if (secondPageAttempts === 1) return jsonResponse({ TOTAL: '100', abslist: [] })
          return jsonResponse({ TOTAL: '100', abslist: kuwoSongs('1', 50) })
        }
        return jsonResponse({ TOTAL: '100', abslist: [] })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['kw'] })

    expect(secondPageAttempts).toBe(2)
    expect(result.kw.flatMap((album) => album.songs)).toHaveLength(100)
  })

  it('writes Kuwo detail publish date to both camel and snake raw fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname.includes('search.kuwo.cn') && url.searchParams.get('stype') === 'albuminfo') {
        return jsonResponse({
          releasedate: '2013-07-07',
          songnum: 1,
          musiclist: [{ releasedate: '2013-07-07' }],
        })
      }
      if (url.hostname.includes('search.kuwo.cn')) {
        return jsonResponse({
          TOTAL: '1',
          abslist: [{
            MUSICRID: 'MUSIC_1',
            SONGNAME: 'Song',
            ARTIST: 'Singer',
            ALBUM: 'Kuwo Album',
            ALBUMID: 'album-1',
            DURATION: '180',
          }],
        })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer')
    const song = result.kw[0].songs[0]

    expect(result.kw[0].publishDate).toBe('2013-07-07')
    expect(song.raw.publishDate).toBe('2013-07-07')
    expect(song.raw.publish_date).toBe('2013-07-07')
  })

  it('filters album songs to the requested artist before counting playlists', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/search/get/web')) {
        return jsonResponse({ result: { artists: [{ id: 1, name: 'Singer', albumSize: 1 }] } })
      }
      if (url.includes('/api/artist/albums/')) {
        return jsonResponse({ artist: { albumSize: 1 }, hotAlbums: [{ id: 11, name: 'Album', size: 2, publishTime: 1704067200000 }] })
      }
      if (url.includes('/api/v1/album/11')) {
        return jsonResponse({ album: { songs: [
          { id: 101, name: 'Keep', artists: [{ name: 'Singer' }], album: { name: 'Album' }, duration: 180000 },
          { id: 102, name: 'Drop', artists: [{ name: 'Other' }], album: { name: 'Album' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer')

    expect(result.wy).toHaveLength(1)
    expect(result.wy[0].songs.map((song) => song.title)).toEqual(['Keep'])
    expect(result.wy[0].songCount).toBe(1)
  })

  it('keeps NetEase Beijing publish dates and artist-owned albums without per-song artists', async () => {
    const beijingMidnight = Date.parse('2025-07-01T16:00:00.000Z')
    let eapiCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        eapiCalls += 1
        if (eapiCalls === 1) {
          return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Penny', albumSize: 1 }] } })
        }
        return jsonResponse({ code: 200, artist: { albumSize: 1 }, hotAlbums: [{ id: 11, name: 'OST Album', size: 2, publishTime: beijingMidnight }] })
      }
      if (url.includes('music.163.com/api/v1/album/11')) {
        return jsonResponse({ album: { publishTime: beijingMidnight, songs: [
          { id: 101, name: 'Keep A', album: { name: 'OST Album' }, duration: 180000 },
          { id: 102, name: 'Keep B', album: { name: 'OST Album' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Penny', undefined, { platforms: ['wy'] })

    expect(result.wy).toHaveLength(1)
    expect(result.wy[0].publishDate).toBe('2025-07-02')
    expect(result.wy[0].songs.map((song) => song.artist)).toEqual(['Penny', 'Penny'])
    expect(result.wy[0].songs.map((song) => song.raw.publishDate)).toEqual(['2025-07-02', '2025-07-02'])
    expect(result.wy[0].songCount).toBe(2)
  })

  it('uses NetEase eapi album pages before local music-api fallback', async () => {
    const urls: string[] = []
    let eapiCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        eapiCalls += 1
        if (eapiCalls === 1) {
          return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Penny', albumSize: 2 }] } })
        }
        return jsonResponse({ code: 200, artist: { albumSize: 2 }, hotAlbums: [
          { id: 11, name: 'Album A', size: 1, publishTime: 1704067200000 },
          { id: 12, name: 'Album B', size: 1, publishTime: 1704153600000 },
        ] })
      }
      if (url.includes('music.163.com/api/v1/album/11')) {
        return jsonResponse({ album: { publishTime: 1704067200000, songs: [
          { id: 101, name: 'Song A', artists: [{ name: 'Penny' }], album: { name: 'Album A' }, duration: 180000 },
        ] } })
      }
      if (url.includes('music.163.com/api/v1/album/12')) {
        return jsonResponse({ album: { publishTime: 1704153600000, songs: [
          { id: 102, name: 'Song B', artists: [{ name: 'Penny' }], album: { name: 'Album B' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Penny', undefined, { platforms: ['wy'] })

    expect(result.wy.map((album) => album.name)).toEqual(['Album A', 'Album B'])
    expect(urls.some((url) => url.startsWith('http://127.0.0.1:3001'))).toBe(false)
    expect(urls.filter((url) => url.startsWith('http://interface.music.163.com/eapi/batch'))).toHaveLength(2)
  })

  it('falls back to local music-api when NetEase eapi fails', async () => {
    const beijingMidnight = Date.parse('2025-07-01T16:00:00.000Z')
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        return new Response('server error', { status: 500 })
      }
      if (url.startsWith('http://127.0.0.1:3001/search')) {
        return jsonResponse({ result: { artists: [{ id: 1, name: 'Penny', albumSize: 1 }] } })
      }
      if (url.startsWith('http://127.0.0.1:3001/artist/album')) {
        return jsonResponse({ more: false, hotAlbums: [{ id: 11, name: 'OST Album', size: 2, publishTime: beijingMidnight }] })
      }
      if (url.startsWith('http://127.0.0.1:3001/album')) {
        return jsonResponse({ album: { publishTime: beijingMidnight, songs: [
          { id: 101, name: 'Keep A', album: { name: 'OST Album' }, duration: 180000 },
          { id: 102, name: 'Keep B', album: { name: 'OST Album' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Penny', undefined, { platforms: ['wy'] })

    expect(result.wy).toHaveLength(1)
    expect(urls.some((url) => url.startsWith('http://127.0.0.1:3001/search'))).toBe(true)
  })

  it('parses Kugou wrapped info lists and keeps the old page size', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/api/v3/search/singer')) {
        expect(url.searchParams.get('pagesize')).toBe('10')
        return jsonResponse({ data: { info: [{ singername: 'Singer', singerid: 99 }] } })
      }
      if (url.pathname.includes('/api/v5/singer/album')) {
        expect(url.searchParams.get('pagesize')).toBe('50')
        return jsonResponse({ data: { info: [{ albumid: 11, albumname: 'Album', publishtime: '2024-01-01', songcount: 1 }] } })
      }
      if (url.pathname.includes('/api/v3/album/song')) {
        return jsonResponse({ data: { info: [{ hash: 'hash-1', songname: 'Song', singername: 'Singer', duration: 180 }] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer')

    expect(result.kg).toHaveLength(1)
    expect(result.kg[0].songs.map((song) => song.title)).toEqual(['Song'])
  })

  it('does not assign mixed Kugou OST songs without matching singers to the requested artist', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/api/v3/search/singer')) {
        return jsonResponse({ data: { info: [{ singername: 'Penny', singerid: 99 }] } })
      }
      if (url.pathname.includes('/api/v5/singer/album')) {
        return jsonResponse({ data: { info: [{ albumid: 11, albumname: 'OST Album', publishtime: '2025-07-02', songcount: 4 }] } })
      }
      if (url.pathname.includes('/api/v3/album/song')) {
        return jsonResponse({ data: { info: [
          { hash: 'hash-keep', songname: 'Theme', singername: 'Penny', duration: 180 },
          { hash: 'hash-other', songname: 'Other Theme', singername: 'Other Singer', duration: 180 },
          { hash: 'hash-parsed-other', filename: 'Other Singer - Parsed Other', duration: 180 },
          { hash: 'hash-missing', songname: 'Missing Singer', duration: 180 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Penny', undefined, { platforms: ['kg'] })

    expect(result.kg).toHaveLength(1)
    expect(result.kg[0].songs).toHaveLength(1)
    expect(result.kg[0].songs[0]).toMatchObject({
      title: 'Theme',
      artist: 'Penny',
    })
    expect(result.kg[0].songCount).toBe(1)
  })

  it('reads Kugou publish_time as the album release date like the previous downloader', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/api/v3/search/singer')) {
        return jsonResponse({ data: { info: [{ singername: 'Singer', singerid: 99 }] } })
      }
      if (url.pathname.includes('/api/v5/singer/album')) {
        return jsonResponse({ data: { info: [{ albumid: 11, albumname: 'Album', publish_time: '2026-04-22 00:00:00', songcount: 1 }] } })
      }
      if (url.pathname.includes('/api/v3/album/song')) {
        return jsonResponse({ data: { info: [{ hash: 'hash-1', songname: 'Song', singername: 'Singer', duration: 180 }] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer')

    expect(result.kg[0].publishDate).toBe('2026-04-22')
    expect(result.kg[0].songs[0].raw.publishDate).toBe('2026-04-22')
  })

  it('uses the first Kugou singer result like MusicAlbumDownloaderGui', async () => {
    const albumSingerIds: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/api/v3/search/singer')) {
        return jsonResponse({ data: { info: [
          { singername: 'Display Name', singerid: 1 },
          { singername: 'Singer', singerid: 2 },
        ] } })
      }
      if (url.pathname.includes('/api/v5/singer/album')) {
        albumSingerIds.push(url.searchParams.get('singerid') || '')
        return jsonResponse({ data: { info: [{ albumid: 11, albumname: 'Album', publishtime: '2024-01-01', songcount: 1 }] } })
      }
      if (url.pathname.includes('/api/v3/album/song')) {
        return jsonResponse({ data: { info: [{ hash: 'hash-1', songname: 'Song', singername: 'Display Name', duration: 180 }] } })
      }
      return jsonResponse({})
    }))

    await fetchArtistPlatformAlbums('Singer')

    expect(albumSingerIds).toEqual(['1', '1', '1'])
  })

  it('uses direct NetEase APIs when eapi and local music-api both fail', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        return new Response('server error', { status: 500 })
      }
      if (url.startsWith('http://127.0.0.1:3001')) {
        return new Response('local error', { status: 500 })
      }
      if (url.includes('music.163.com/api/search/get/web')) {
        return jsonResponse({ result: { artists: [{ id: 1, name: 'Singer' }] } })
      }
      if (url.includes('music.163.com/api/artist/albums/')) {
        return jsonResponse({ more: false, hotAlbums: [{ id: 11, name: 'Album', size: 1, publishTime: 1704067200000 }] })
      }
      if (url.includes('music.163.com/api/v1/album/11')) {
        return jsonResponse({ album: { publishTime: 1704067200000, songs: [
          { id: 101, name: 'Song', artists: [{ name: 'Singer' }], album: { name: 'Album' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(result.wy.flatMap((album) => album.songs).map((song) => song.title)).toEqual(['Song'])
    expect(urls.some((url) => url.startsWith('http://127.0.0.1:3001/search'))).toBe(true)
    expect(urls.some((url) => url.includes('music.163.com/api/search/get/web'))).toBe(true)
  })

  it('continues NetEase eapi album pages until artist albumSize is reached', async () => {
    let eapiCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        eapiCalls += 1
        if (eapiCalls === 1) {
          return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Singer', albumSize: 3 }] } })
        }
        if (eapiCalls === 2) {
          return jsonResponse({ code: 200, artist: { albumSize: 3 }, hotAlbums: [
            { id: 11, name: 'Album A', size: 1, publishTime: 1704067200000 },
            { id: 12, name: 'Album B', size: 1, publishTime: 1704153600000 },
          ] })
        }
        return jsonResponse({ code: 200, artist: { albumSize: 3 }, hotAlbums: [
          { id: 13, name: 'Album C', size: 1, publishTime: 1704240000000 },
        ] })
      }
      if (url.includes('music.163.com/api/v1/album/')) {
        const id = new URL(url).pathname.split('/').pop()
        return jsonResponse({ album: { publishTime: 1704067200000, songs: [
          { id: Number(id), name: `Song ${id}`, artists: [{ name: 'Singer' }], album: { name: `Album ${id}` }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(result.wy).toHaveLength(3)
    expect(eapiCalls).toBe(3)
  })

  it('supplements incomplete NetEase album details until eapi albumSize is reached', async () => {
    const detailCalls = new Map<string, number>()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Singer', albumSize: 3 }] }, artist: { albumSize: 3 }, hotAlbums: [
          { id: 11, name: 'Album A', size: 1, publishTime: 1704067200000 },
          { id: 12, name: 'Album B', size: 1, publishTime: 1704153600000 },
          { id: 13, name: 'Album C', size: 1, publishTime: 1704240000000 },
        ] })
      }
      if (url.includes('music.163.com/api/v1/album/')) {
        const id = new URL(url).pathname.split('/').pop() || ''
        const calls = (detailCalls.get(id) || 0) + 1
        detailCalls.set(id, calls)
        const readyAfter = id === '11' ? 1 : id === '12' ? 4 : 7
        if (calls < readyAfter) return jsonResponse({ album: { publishTime: 1704067200000, songs: [] } })
        return jsonResponse({ album: { publishTime: 1704067200000, songs: [
          { id: Number(id), name: `Song ${id}`, artists: [{ name: 'Singer' }], album: { name: `Album ${id}` }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(result.wy).toHaveLength(3)
    expect(result.wy.map((album) => album.platformAlbumId)).toEqual(['11', '12', '13'])
  })

  it('uses NetEase eapi seed count instead of smaller artist albumSize for detail completeness', async () => {
    const messages: string[] = []
    let missingAlbumDetailCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Singer', albumSize: 1 }] }, artist: { albumSize: 1 }, hotAlbums: [
          { id: 11, name: 'Album A', size: 1, publishTime: 1704067200000 },
          { id: 12, name: 'Album B', size: 1, publishTime: 1704153600000 },
        ] })
      }
      if (url.includes('music.163.com/api/v1/album/11')) {
        return jsonResponse({ album: { publishTime: 1704067200000, songs: [
          { id: 101, name: 'Song 11', artists: [{ name: 'Singer' }], album: { name: 'Album A' }, duration: 180000 },
        ] } })
      }
      if (url.includes('music.163.com/api/v1/album/12')) {
        missingAlbumDetailCalls += 1
        return jsonResponse({ album: { publishTime: 1704153600000, songs: [] }, songs: [] })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', (progress) => {
      if (progress.platform === 'wy') messages.push(progress.message)
    }, { platforms: ['wy'] })

    expect(result.wy).toHaveLength(1)
    expect(missingAlbumDetailCalls).toBeGreaterThan(3)
    expect(messages.some((message) => message.includes('Album B'))).toBe(true)
  })

  it('sends NetEase referer when fetching album details that reject generic headers', async () => {
    const seeds = Array.from({ length: 28 }, (_, index) => ({
      id: index + 1,
      name: index === 27 ? 'No Penn, No Gain' : `Album ${index + 1}`,
      size: 1,
      publishTime: 1704067200000 + index * 86400000,
    }))
    const detailReferers: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Singer', albumSize: 24 }] }, artist: { albumSize: 24 }, hotAlbums: seeds })
      }
      if (url.includes('music.163.com/api/v1/album/')) {
        const id = Number(new URL(url).pathname.split('/').pop())
        const headers = new Headers(init?.headers)
        const referer = headers.get('referer') || ''
        detailReferers.push(referer)
        if (id === 28 && referer !== 'https://music.163.com/') {
          return jsonResponse({ code: -462, album: { publishTime: 1704067200000, songs: [] }, songs: [] })
        }
        return jsonResponse({ code: 200, album: { publishTime: 1704067200000, songs: [
          { id: 1000 + id, name: `Song ${id}`, artists: [{ name: 'Singer' }], album: { name: id === 28 ? 'No Penn, No Gain' : `Album ${id}` }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(result.wy).toHaveLength(28)
    expect(result.wy.map((album) => album.name)).toContain('No Penn, No Gain')
    expect(detailReferers.every((referer) => referer === 'https://music.163.com/')).toBe(true)
  })

  it('uses stable NetEase v1 album detail endpoint instead of the flaky legacy album endpoint', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Singer', albumSize: 1 }] }, artist: { albumSize: 1 }, hotAlbums: [
          { id: 11, name: 'Album', size: 1, publishTime: 1704067200000 },
        ] })
      }
      if (url.includes('music.163.com/api/album/11')) {
        return jsonResponse({ code: -462, album: { publishTime: 1704067200000, songs: [] }, songs: [] })
      }
      if (url.includes('music.163.com/api/v1/album/11')) {
        return jsonResponse({ code: 200, album: { publishTime: 1704067200000, songs: [
          { id: 101, name: 'Song', artists: [{ name: 'Singer' }], album: { name: 'Album' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(result.wy).toHaveLength(1)
    expect(result.wy[0].songs.map((song) => song.title)).toEqual(['Song'])
    expect(urls.some((url) => url.includes('music.163.com/api/album/11'))).toBe(false)
    expect(urls.some((url) => url.includes('music.163.com/api/v1/album/11'))).toBe(true)
  })

  it('reports missing NetEase albums when supplement attempts remain incomplete', async () => {
    const messages: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Singer', albumSize: 3 }] }, artist: { albumSize: 3 }, hotAlbums: [
          { id: 11, name: 'Album A', size: 1, publishTime: 1704067200000 },
          { id: 12, name: 'Album B', size: 1, publishTime: 1704153600000 },
          { id: 13, name: 'Album C', size: 1, publishTime: 1704240000000 },
        ] })
      }
      if (url.includes('music.163.com/api/v1/album/')) {
        const id = new URL(url).pathname.split('/').pop()
        if (id === '13') return jsonResponse({ code: -462, album: { publishTime: 1704067200000, songs: [] }, songs: [] })
        return jsonResponse({ album: { publishTime: 1704067200000, songs: [
          { id: Number(id), name: `Song ${id}`, artists: [{ name: 'Singer' }], album: { name: `Album ${id}` }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', (progress) => {
      if (progress.platform === 'wy') messages.push(progress.message)
    }, { platforms: ['wy'] })

    expect(result.wy).toHaveLength(2)
    expect(messages.some((message) => message.includes('2'))).toBe(true)
    expect(messages.some((message) => message.includes('Album C'))).toBe(true)
    expect(messages.some((message) => message.includes('code=-462'))).toBe(true)
  })

  it('limits NetEase album detail requests to two concurrent requests', async () => {
    let activeAlbumDetails = 0
    let maxAlbumDetails = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Singer', albumSize: 4 }] }, artist: { albumSize: 4 }, hotAlbums: [
          { id: 11, name: 'Album A', size: 1, publishTime: 1704067200000 },
          { id: 12, name: 'Album B', size: 1, publishTime: 1704153600000 },
          { id: 13, name: 'Album C', size: 1, publishTime: 1704240000000 },
          { id: 14, name: 'Album D', size: 1, publishTime: 1704326400000 },
        ] })
      }
      if (url.includes('music.163.com/api/v1/album/')) {
        activeAlbumDetails += 1
        maxAlbumDetails = Math.max(maxAlbumDetails, activeAlbumDetails)
        await Promise.resolve()
        activeAlbumDetails -= 1
        const id = new URL(url).pathname.split('/').pop()
        return jsonResponse({ album: { publishTime: 1704067200000, songs: [
          { id: Number(id), name: `Song ${id}`, artists: [{ name: 'Singer' }], album: { name: `Album ${id}` }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(maxAlbumDetails).toBe(2)
  })

  it('does not use local music-api when NetEase eapi succeeds', async () => {
    const urls: string[] = []
    let eapiCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('http://interface.music.163.com/eapi/batch')) {
        eapiCalls += 1
        if (eapiCalls === 1) {
          return jsonResponse({ code: 200, result: { artists: [{ id: 1, name: 'Singer', albumSize: 1 }] } })
        }
        return jsonResponse({ code: 200, artist: { albumSize: 1 }, hotAlbums: [{ id: 11, name: 'Album', size: 1, publishTime: 1704067200000 }] })
      }
      if (url.startsWith('http://127.0.0.1:3001/search')) {
        return jsonResponse({ result: { artists: [{ id: 1, name: 'Singer' }] } })
      }
      if (url.includes('music.163.com/api/v1/album/11')) {
        return jsonResponse({ album: { publishTime: 1704067200000, songs: [
          { id: 101, name: 'Song', artists: [{ name: 'Singer' }], album: { name: 'Album' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(result.wy.flatMap((album) => album.songs).map((song) => song.title)).toEqual(['Song'])
    expect(urls.some((url) => url.startsWith('http://127.0.0.1:3001'))).toBe(false)
  })

  it('retries transient HTTP failures when fetching album details', async () => {
    let albumAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/search/get/web')) {
        return jsonResponse({ result: { artists: [{ id: 1, name: 'Singer', albumSize: 1 }] } })
      }
      if (url.includes('/api/artist/albums/')) {
        return jsonResponse({ artist: { albumSize: 1 }, hotAlbums: [{ id: 11, name: 'Album', size: 1, publishTime: 1704067200000 }] })
      }
      if (url.includes('/api/v1/album/11')) {
        albumAttempts += 1
        if (albumAttempts === 1) return new Response('', { status: 503 })
        return jsonResponse({ album: { songs: [
          { id: 101, name: 'Song', artists: [{ name: 'Singer' }], album: { name: 'Album' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(albumAttempts).toBe(2)
    expect(result.wy.flatMap((album) => album.songs).map((song) => song.title)).toEqual(['Song'])
  })

  it('retries transient empty album detail song lists when the album declares songs', async () => {
    let albumAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/search/get/web')) {
        return jsonResponse({ result: { artists: [{ id: 1, name: 'Singer', albumSize: 1 }] } })
      }
      if (url.includes('/api/artist/albums/')) {
        return jsonResponse({ artist: { albumSize: 1 }, hotAlbums: [{ id: 11, name: 'Album', size: 1, publishTime: 1704067200000 }] })
      }
      if (url.includes('/api/v1/album/11')) {
        albumAttempts += 1
        if (albumAttempts === 1) return jsonResponse({ album: { songs: [] }, songs: [] })
        return jsonResponse({ album: { songs: [
          { id: 101, name: 'Song', artists: [{ name: 'Singer' }], album: { name: 'Album' }, duration: 180000 },
        ] } })
      }
      return jsonResponse({})
    }))

    const result = await fetchArtistPlatformAlbums('Singer', undefined, { platforms: ['wy'] })

    expect(albumAttempts).toBe(2)
    expect(result.wy.flatMap((album) => album.songs).map((song) => song.title)).toEqual(['Song'])
  })
})

function kuwoSongs(page: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    MUSICRID: `MUSIC_${page}-${index}`,
    SONGNAME: `Song ${page}-${index}`,
    ARTIST: 'Singer',
    ALBUM: `Album ${page}-${index}`,
    ALBUMID: `album-${page}-${index}`,
    DURATION: '180',
  }))
}

function album(platform: string, name: string) {
  return {
    id: `${platform}:${name}`,
    platform,
    platformAlbumId: name,
    artistName: 'Singer',
    name,
    publishDate: '2024-01-01',
    songCount: 1,
    songs: [],
    raw: {},
  }
}

function qqSong(mid: string, name: string, albumMid: string, albumName: string, singers = [{ name: 'Singer', mid: 'singer-mid' }]) {
  return {
    songInfo: {
      mid,
      id: mid,
      name,
      interval: 180,
      singer: singers,
      album: { mid: albumMid, name: albumName },
      file: { size_128mp3: 1, size_320mp3: 1, size_flac: 1 },
    },
  }
}

function parseMusicuPayload(url: string, init?: RequestInit): any {
  const data = new URL(url).searchParams.get('data')
  if (data) return JSON.parse(data)
  return JSON.parse(String(init?.body || '{}'))
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
