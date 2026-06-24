import crypto from 'node:crypto'
import { normalizeCompareText } from '../core/naming'
import { PLATFORM_LABELS, type Album, type Platform, type Quality, type Song } from '../core/types'

export interface FetchProgress {
  platform: Platform | 'all'
  stage: string
  current?: number
  total?: number
  message: string
  error?: string
}

export type ProgressCallback = (progress: FetchProgress) => void

export interface FetchArtistPlatformAlbumsOptions {
  platforms?: Platform[]
  expectedAlbumCounts?: Partial<Record<Platform, number>>
}

interface RawAlbumSeed {
  id: string
  mid?: string
  name: string
  artistName: string
  publishDate?: string
  songCount?: number
  coverUrl?: string
  raw?: Record<string, unknown>
}

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Referer: 'https://y.qq.com/',
  Accept: 'application/json, text/plain, */*',
}
const NETEASE_HEADERS = {
  'User-Agent': DEFAULT_HEADERS['User-Agent'],
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
  Accept: DEFAULT_HEADERS.Accept,
}

const QQ_REFERER = 'https://y.qq.com/'
const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg'
const QQ_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_ALBUM_PAGE_SIZE = 80
const KUWO_PAGE_SIZE = 50
const KUWO_MAX_PAGES = 20
const NETEASE_MUSIC_API_BASE = 'http://127.0.0.1:3001'
const NETEASE_EAPI_URL = 'http://interface.music.163.com/eapi/batch'
const NETEASE_EAPI_KEY = 'e82ckenh8dichen8'
const FETCH_ATTEMPTS = 3
const FETCH_RETRY_DELAYS_MS = [0, 120, 360]
const NETEASE_ALBUM_DETAIL_RETRY_DELAYS_MS = [0, 800, 1800]
export const PLATFORM_ATTEMPT_COUNT = 3
const PLATFORM_FETCH_CONCURRENCY = 2
const NORMAL_ATTEMPT_DELAY_MS: readonly [number, number] = [2000, 5000]
const FAILED_ATTEMPT_DELAY_MS: readonly [number, number] = [8000, 15000]
const RATE_LIMIT_DELAY_MS: readonly [number, number] = [20000, 45000]
const DEFAULT_ALBUM_DETAIL_CONCURRENCY = 3
const KUGOU_ALBUM_DETAIL_CONCURRENCY = 2
const NETEASE_ALBUM_DETAIL_CONCURRENCY = 2
const NETEASE_DETAIL_SUPPLEMENT_ATTEMPTS = 3
const KUGOU_NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
}
const KUWO_DATE_KEYS = ['pub', 'releasedate', 'releaseDate', 'RELEASEDATE', 'publishDate', 'publish_date', 'publish_time', 'publishTime', 'pubTime', 'releaseTime', 'release_time', 'public_time', 'publicTime', 'Fpublic_time', 'date']

interface PlatformFetchRuntime {
  sleep: (ms: number) => Promise<void>
  randomInt: (min: number, max: number) => number
}

const defaultPlatformFetchRuntime: PlatformFetchRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
}

let platformFetchRuntime = defaultPlatformFetchRuntime

export function setPlatformFetchRuntimeForTests(runtime: Partial<PlatformFetchRuntime>): void {
  platformFetchRuntime = { ...platformFetchRuntime, ...runtime }
}

export function resetPlatformFetchRuntimeForTests(): void {
  platformFetchRuntime = defaultPlatformFetchRuntime
}

export interface PlatformFetchAttempt {
  albums?: Album[]
  error?: unknown
}

export interface PlatformFetchSelection {
  albums: Album[]
  counts: string[]
  consistent: boolean
  allFailed: boolean
}

export function selectBestAttempt(attempts: PlatformFetchAttempt[]): PlatformFetchSelection {
  const successes = attempts
    .map((attempt, index) => ({ attempt, index }))
    .filter((entry): entry is { attempt: { albums: Album[] }, index: number } => Array.isArray(entry.attempt.albums))
  const counts = attempts.map((attempt) => Array.isArray(attempt.albums) ? String(attempt.albums.length) : '失败')
  if (!successes.length) return { albums: [], counts, consistent: false, allFailed: true }

  const successCounts = successes.map((entry) => entry.attempt.albums.length)
  const consistent = successes.length === attempts.length && successCounts.every((count) => count === successCounts[0])
  if (consistent) {
    const last = successes[successes.length - 1]
    return { albums: last.attempt.albums, counts, consistent: true, allFailed: false }
  }

  let best = successes[0]
  for (const entry of successes.slice(1)) {
    const entryCount = entry.attempt.albums.length
    const bestCount = best.attempt.albums.length
    if (entryCount > bestCount || entryCount === bestCount) best = entry
  }
  return { albums: best.attempt.albums, counts, consistent: false, allFailed: false }
}

export async function fetchArtistPlatformAlbums(
  artistName: string,
  progress?: ProgressCallback,
  options: FetchArtistPlatformAlbumsOptions = {},
): Promise<Record<string, Album[]>> {
  const result: Record<string, Album[]> = { kw: [], kg: [], tx: [], wy: [] }
  const adapters: Array<[Platform, (artistName: string, progress?: ProgressCallback) => Promise<Album[]>]> = [
    ['kw', fetchKuwoAlbums],
    ['kg', fetchKugouAlbums],
    ['tx', fetchQQAlbums],
    ['wy', fetchNeteaseAlbums],
  ]
  const enabledPlatforms = options.platforms ? new Set(options.platforms) : null
  const enabledAdapters = adapters.filter(([platform]) => !enabledPlatforms || enabledPlatforms.has(platform))
  let nextPlatformIndex = 0
  const workers = Array.from(
    { length: Math.min(PLATFORM_FETCH_CONCURRENCY, enabledAdapters.length) },
    async () => {
      for (;;) {
        const entry = enabledAdapters[nextPlatformIndex++]
        if (!entry) return
        const [platform, adapter] = entry
        progress?.({ platform, stage: 'start', message: `${PLATFORM_LABELS[platform]}：搜索歌手` })
        try {
          const albums = await fetchPlatformWithConsistencyCheck(
            platform,
            adapter,
            artistName,
            progress,
            options.expectedAlbumCounts?.[platform],
          )
          result[platform] = albums
          progress?.({ platform, stage: 'done', current: albums.length, total: albums.length, message: `${PLATFORM_LABELS[platform]}：完成 ${albums.length} 张专辑` })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          progress?.({ platform, stage: 'failed', message: `${PLATFORM_LABELS[platform]}：抓取失败`, error: message })
          result[platform] = []
        }
      }
    },
  )
  await Promise.all(workers)
  progress?.({ platform: 'all', stage: 'done', message: '全部平台抓取完成' })
  return result
}

export async function searchPlatformSongs(query: string, platforms: Platform[] = ['kg', 'tx', 'wy', 'kw'], limit = 20): Promise<Song[]> {
  const tasks = platforms.map(async (platform) => {
    try {
      if (platform === 'kg') return await searchKugouSongs(query, limit)
      if (platform === 'tx') return await searchQQSongs(query, limit)
      if (platform === 'wy') return await searchNeteaseSongs(query, limit)
      if (platform === 'kw') return await searchKuwoSongs(query, limit)
    } catch {
      return []
    }
    return []
  })
  return (await Promise.all(tasks)).flat()
}

async function fetchPlatformWithConsistencyCheck(
  platform: Platform,
  adapter: (artistName: string, progress?: ProgressCallback) => Promise<Album[]>,
  artistName: string,
  progress?: ProgressCallback,
  expectedAlbumCount?: number,
): Promise<Album[]> {
  const attempts: PlatformFetchAttempt[] = []
  for (let attempt = 0; attempt < PLATFORM_ATTEMPT_COUNT; attempt++) {
    progress?.({
      platform,
      stage: 'attempt',
      current: attempt + 1,
      total: PLATFORM_ATTEMPT_COUNT,
      message: `${PLATFORM_LABELS[platform]}：第 ${attempt + 1}/${PLATFORM_ATTEMPT_COUNT} 轮抓取中`,
    })
    try {
      const albums = filterArtistAlbums(artistName, await adapter(artistName, progress))
      attempts.push({ albums })
    } catch (error) {
      attempts.push({ error })
      const message = error instanceof Error ? error.message : String(error)
      progress?.({
        platform,
        stage: 'attempt_failed',
        current: attempt + 1,
        total: PLATFORM_ATTEMPT_COUNT,
        message: `${PLATFORM_LABELS[platform]}：第 ${attempt + 1}/${PLATFORM_ATTEMPT_COUNT} 轮抓取失败`,
        error: message,
      })
    }

    if (!shouldRetryPlatformAttempt(attempts, expectedAlbumCount) || attempt >= PLATFORM_ATTEMPT_COUNT - 1) break
    const lastAttempt = attempts[attempt]
    const range = lastAttempt.error
      ? (isRateLimitLikeError(lastAttempt.error) ? RATE_LIMIT_DELAY_MS : FAILED_ATTEMPT_DELAY_MS)
      : NORMAL_ATTEMPT_DELAY_MS
    const delay = randomDelay(range)
    const nextAttempt = attempt + 2
    progress?.({
      platform,
      stage: 'wait',
      current: nextAttempt,
      total: PLATFORM_ATTEMPT_COUNT,
      message: retryWaitMessage(platform, lastAttempt, expectedAlbumCount, delay, nextAttempt),
    })
    await platformFetchRuntime.sleep(delay)
  }

  const selected = selectBestAttempt(attempts)
  if (selected.allFailed) {
    const errorText = attempts.map((attempt) => attempt.error instanceof Error ? attempt.error.message : String(attempt.error || '失败')).join('；')
    throw new Error(errorText || `${PLATFORM_LABELS[platform]}：三次抓取均失败`)
  }
  if (selected.consistent) {
    progress?.({
      platform,
      stage: 'consistent',
      current: selected.albums.length,
      total: selected.albums.length,
      message: attempts.length === 1
        ? `${PLATFORM_LABELS[platform]}：首轮抓取完成（${selected.albums.length} 张专辑）`
        : `${PLATFORM_LABELS[platform]}：${attempts.length} 轮抓取专辑数量一致（${selected.albums.length}），使用第 ${attempts.length} 轮结果`,
    })
  } else {
    progress?.({
      platform,
      stage: 'inconsistent',
      current: selected.albums.length,
      total: selected.albums.length,
      message: `${PLATFORM_LABELS[platform]}：抓取专辑数量不一致（${selected.counts.join(' / ')}），已使用 ${selected.albums.length} 张结果`,
    })
  }
  return selected.albums
}

function shouldRetryPlatformAttempt(attempts: PlatformFetchAttempt[], expectedAlbumCount?: number): boolean {
  const lastAttempt = attempts[attempts.length - 1]
  if (!lastAttempt) return true
  if (lastAttempt.error) return true
  const count = lastAttempt.albums?.length ?? 0
  if (count <= 0) return true
  return clearlyBelowExpectedAlbumCount(count, expectedAlbumCount)
}

function clearlyBelowExpectedAlbumCount(count: number, expectedAlbumCount?: number): boolean {
  if (!expectedAlbumCount || expectedAlbumCount <= 0) return false
  if (count >= expectedAlbumCount) return false
  const missing = expectedAlbumCount - count
  const tolerance = Math.max(3, Math.ceil(expectedAlbumCount * 0.1))
  return missing >= tolerance
}

function retryWaitMessage(
  platform: Platform,
  lastAttempt: PlatformFetchAttempt,
  expectedAlbumCount: number | undefined,
  delay: number,
  nextAttempt: number,
): string {
  const seconds = Math.ceil(delay / 1000)
  const count = lastAttempt.albums?.length ?? 0
  if (lastAttempt.error) return `${PLATFORM_LABELS[platform]}：等待 ${seconds} 秒后开始第 ${nextAttempt} 轮，避免请求过快`
  if (clearlyBelowExpectedAlbumCount(count, expectedAlbumCount)) {
    return `${PLATFORM_LABELS[platform]}：首轮结果明显少于本地已有 ${expectedAlbumCount} 张，等待 ${seconds} 秒后补抓第 ${nextAttempt} 轮`
  }
  return `${PLATFORM_LABELS[platform]}：等待 ${seconds} 秒后开始第 ${nextAttempt} 轮，避免请求过快`
}

async function fetchNeteaseAlbums(artistName: string, progress?: ProgressCallback): Promise<Album[]> {
  try {
    return await fetchNeteaseAlbumsFromEapi(artistName, progress)
  } catch {
    try {
      return await fetchNeteaseAlbumsFromMusicApi(artistName, progress)
    } catch {
      return fetchNeteaseAlbumsDirect(artistName, progress)
    }
  }
}

async function searchNeteaseSongs(query: string, limit: number): Promise<Song[]> {
  const body = await fetchJson<any>(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(query)}&type=1&offset=0&limit=${limit}`, { headers: NETEASE_HEADERS })
  const rawSongs = body?.result?.songs || []
  return rawSongs.map((item: any, index: number) => {
    const album = item.album || item.al || {}
    return makeSong({
      platform: 'wy',
      platformSongId: String(item.id),
      title: item.name,
      artist: formatArtistNames(item.artists || item.ar),
      albumId: stableId('wy:album', album.id || album.name || ''),
      albumName: album.name || '',
      duration: Math.round(Number(item.duration || item.dt || 0) / 1000),
      trackNo: Number(item.no || index + 1),
      coverUrl: album.picUrl || '',
      qualitys: ['128k', '320k', 'flac'],
      raw: { ...item, publishDate: dateFromMs(album.publishTime) || '', albumSongCount: 0 },
    })
  })
}

async function fetchNeteaseAlbumsFromEapi(artistName: string, progress?: ProgressCallback): Promise<Album[]> {
  progress?.({ platform: 'wy', stage: 'search', message: '网易云音乐：使用 eapi 搜索歌手' })
  const search = await neteaseEapi<any>('/api/search/get/web', {
    s: artistName,
    type: 100,
    limit: 5,
    offset: 0,
    total: true,
  })
  const searchBody = unwrapNeteaseEapiBody(search)
  const artist = (searchBody?.result?.artists || [])[0]
  if (!artist) throw new Error('未找到歌手')

  const albums: RawAlbumSeed[] = []
  const seen = new Set<string>()
  const limit = 100
  let expectedTotal = Number(artist.albumSize || 0)
  for (let offset = 0; ; offset += limit) {
    progress?.({ platform: 'wy', stage: 'albums', current: albums.length, total: expectedTotal || undefined, message: `网易云音乐：使用 eapi 抓取专辑列表 ${albums.length}/${expectedTotal || '?'}` })
    const body = unwrapNeteaseEapiBody(await neteaseEapi<any>(`/api/artist/albums/${artist.id}`, { limit, offset }))
    const rawAlbums = body?.hotAlbums || []
    for (const item of rawAlbums) {
      const albumId = String(item.id || '')
      if (!albumId || seen.has(albumId)) continue
      seen.add(albumId)
      albums.push(neteaseAlbumSeed(item, artistName))
    }
    const total = Number(body?.artist?.albumSize || expectedTotal || 0)
    if (total > expectedTotal) expectedTotal = total
    if (!rawAlbums.length || (total > 0 && albums.length >= total)) break
  }
  if (!albums.length) throw new Error('网易云 eapi 未返回专辑')

  return fetchNeteaseAlbumDetailsWithCompletenessCheck(artistName, albums, Math.max(expectedTotal, albums.length), progress)
}

async function fetchNeteaseAlbumDetailsWithCompletenessCheck(
  artistName: string,
  seeds: RawAlbumSeed[],
  expectedTotal: number,
  progress?: ProgressCallback,
): Promise<Album[]> {
  const accepted = new Map<string, Album>()
  let best: Album[] = []
  let missingSeeds = seeds
  const expected = seeds.length || expectedTotal

  for (let round = 0; round < NETEASE_DETAIL_SUPPLEMENT_ATTEMPTS && missingSeeds.length; round++) {
    if (round > 0) {
      progress?.({
        platform: 'wy',
        stage: 'wait',
        current: round + 1,
        total: NETEASE_DETAIL_SUPPLEMENT_ATTEMPTS,
        message: `网易云音乐：等待后补抓缺失专辑（第 ${round + 1}/${NETEASE_DETAIL_SUPPLEMENT_ATTEMPTS} 轮）`,
      })
      await platformFetchRuntime.sleep(randomDelay(FAILED_ATTEMPT_DELAY_MS))
    }

    const albums = await fetchNeteaseAlbumDetailRound(artistName, missingSeeds, seeds.length, progress, round === 0 ? NETEASE_ALBUM_DETAIL_CONCURRENCY : 1)
    const filtered = filterArtistAlbums(artistName, albums)
    for (const album of filtered) accepted.set(album.platformAlbumId, album)

    const current = orderedAcceptedAlbums(seeds, accepted)
    if (current.length > best.length) best = current
    if (expected <= 0 || current.length >= expected) return current

    missingSeeds = seeds.filter((seed) => !accepted.has(String(seed.id || seed.mid || seed.name)))
    if (missingSeeds.length && round < NETEASE_DETAIL_SUPPLEMENT_ATTEMPTS - 1) {
      progress?.({
        platform: 'wy',
        stage: 'incomplete',
        current: current.length,
        total: expected,
        message: `网易云音乐：预期 ${expected} 张，实际 ${current.length} 张，继续补抓缺失专辑`,
      })
    }
  }

  if (expected > 0 && best.length < expected) {
    const missingNames = seeds
      .filter((seed) => !accepted.has(String(seed.id || seed.mid || seed.name)))
      .map((seed) => seed.name)
      .filter(Boolean)
    const missingCount = Math.max(expected - best.length, missingNames.length)
    progress?.({
      platform: 'wy',
      stage: 'incomplete',
      current: best.length,
      total: expected,
      message: `网易云音乐：预期 ${expected} 张，实际 ${best.length} 张，缺失 ${missingCount} 张${missingNames.length ? `：${missingNames.join('、')}` : ''}`,
    })
  }
  return best
}

async function fetchNeteaseAlbumDetailRound(
  artistName: string,
  seeds: RawAlbumSeed[],
  total: number,
  progress?: ProgressCallback,
  concurrency = NETEASE_ALBUM_DETAIL_CONCURRENCY,
): Promise<Album[]> {
  const albums: Array<Album | undefined> = new Array(seeds.length)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, seeds.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex++
      const seed = seeds[index]
      if (!seed) return
      try {
        progress?.({ platform: 'wy', stage: 'album', current: index + 1, total, message: `网易云音乐：抓取 ${seed.name}` })
        const songs = await fetchAlbumSongsWithRetry(seed, index, async () => {
          const body = await fetchJson<any>(`https://music.163.com/api/v1/album/${seed.id}`, { headers: NETEASE_HEADERS })
          return neteaseSongsFromAlbumBody(body, seed)
        }, waitForNeteaseAlbumDetailRetry)
        albums[index] = makeAlbum('wy', artistName, seed, songs)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        progress?.({ platform: 'wy', stage: 'album_failed', current: index + 1, total, message: `网易云音乐：${seed.name} 抓取失败：${message}`, error: message })
      }
    }
  })
  await Promise.all(workers)
  return albums.filter((album): album is Album => Boolean(album))
}

function orderedAcceptedAlbums(seeds: RawAlbumSeed[], accepted: Map<string, Album>): Album[] {
  return seeds
    .map((seed) => accepted.get(String(seed.id || seed.mid || seed.name)))
    .filter((album): album is Album => Boolean(album))
}

async function fetchNeteaseAlbumsFromMusicApi(artistName: string, progress?: ProgressCallback): Promise<Album[]> {
  progress?.({ platform: 'wy', stage: 'fallback', message: '网易云音乐：eapi 失败，使用 music-api 兜底' })
  const search = await fetchJson<any>(withQuery(`${NETEASE_MUSIC_API_BASE}/search`, { keywords: artistName, type: 100, limit: 1 }))
  const artist = (search?.result?.artists || [])[0]
  if (!artist) throw new Error('未找到歌手')
  const albums: RawAlbumSeed[] = []
  const limit = 100
  for (let offset = 0; ; offset += limit) {
    const body = await fetchJson<any>(withQuery(`${NETEASE_MUSIC_API_BASE}/artist/album`, { id: artist.id, limit, offset }))
    const rawAlbums = body?.hotAlbums || []
    for (const item of rawAlbums) albums.push(neteaseAlbumSeed(item, artistName))
    if (!rawAlbums.length || rawAlbums.length < limit || body?.more === false) break
  }
  return fetchAlbumDetails('wy', artistName, albums, async (seed, index) => {
    progress?.({ platform: 'wy', stage: 'album', current: index + 1, total: albums.length, message: `网易云音乐：抓取 ${seed.name}` })
    const body = await fetchJson<any>(withQuery(`${NETEASE_MUSIC_API_BASE}/album`, { id: seed.id }))
    return neteaseSongsFromAlbumBody(body, seed)
  })
}

async function fetchNeteaseAlbumsDirect(artistName: string, progress?: ProgressCallback): Promise<Album[]> {
  progress?.({ platform: 'wy', stage: 'fallback', message: '网易云音乐：music-api 失败，使用公开接口兜底' })
  const search = await fetchJson<any>(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(artistName)}&type=100&offset=0&limit=5`, { headers: NETEASE_HEADERS })
  const artist = (search?.result?.artists || [])[0]
  if (!artist) throw new Error('未找到歌手')
  const albums: RawAlbumSeed[] = []
  const limit = 100
  for (let offset = 0; ; offset += limit) {
    const body = await fetchJson<any>(`https://music.163.com/api/artist/albums/${artist.id}?offset=${offset}&limit=${limit}`, { headers: NETEASE_HEADERS })
    const rawAlbums = body?.hotAlbums || []
    for (const item of rawAlbums) albums.push(neteaseAlbumSeed(item, artistName))
    if (!rawAlbums.length || rawAlbums.length < limit || body?.more === false) break
  }
  return fetchAlbumDetails('wy', artistName, albums, async (seed, index) => {
    progress?.({ platform: 'wy', stage: 'album', current: index + 1, total: albums.length, message: `网易云音乐：抓取 ${seed.name}` })
    const body = await fetchJson<any>(`https://music.163.com/api/v1/album/${seed.id}`, { headers: NETEASE_HEADERS })
    return neteaseSongsFromAlbumBody(body, seed)
  })
}

function neteaseAlbumSeed(item: any, artistName: string): RawAlbumSeed {
  return {
    id: String(item.id),
    name: String(item.name || ''),
    artistName,
    publishDate: dateFromMs(item.publishTime) || normalizeDate(item.publishTime),
    songCount: Number(item.size || 0),
    coverUrl: item.picUrl,
    raw: item,
  }
}

function neteaseSongsFromAlbumBody(body: any, seed: RawAlbumSeed): Song[] {
  if (body?.code != null && Number(body.code) !== 200) {
    throw new Error(`网易云专辑详情失败：code=${body.code}`)
  }
  const albumObj = body?.album || {}
  const rawSongs = body?.songs || albumObj?.songs || []
  const publishDate = dateFromMs(albumObj.publishTime) || seed.publishDate || ''
  const coverUrl = albumObj.picUrl || seed.coverUrl
  return rawSongs.map((item: any, songIndex: number) => {
    const albumInfo = item.al || item.album || {}
    const artists = formatArtistNames(item.ar || item.artists) || seed.artistName
    return makeSong({
      platform: 'wy',
      platformSongId: String(item.id),
      title: item.name,
      artist: artists,
      albumId: stableId('wy:album', seed.id),
      albumName: albumInfo.name || seed.name,
      duration: Math.round(Number(item.dt || item.duration || 0) / 1000),
      trackNo: Number(item.no || songIndex + 1),
      coverUrl: albumInfo.picUrl || coverUrl,
      qualitys: ['128k', '320k', 'flac'],
      raw: { ...item, publishDate, albumSongCount: rawSongs.length || seed.songCount || 0 },
    })
  })
}

async function fetchKugouAlbums(artistName: string, progress?: ProgressCallback): Promise<Album[]> {
  const search = await fetchJson<any>(`https://mobiles.kugou.com/api/v3/search/singer?format=json&keyword=${encodeURIComponent(artistName)}&page=1&pagesize=10`)
  const artist = infoList(search)[0]
  if (!artist) throw new Error('未找到歌手')
  const albums: RawAlbumSeed[] = []
  const seen = new Set<string>()
  const pageSize = 50
  for (let page = 1; ; page++) {
    const body = await fetchJson<any>(withQuery('https://mobiles.kugou.com/api/v5/singer/album', {
      singerid: artist.singerid,
      page,
      pagesize: pageSize,
      _: Date.now(),
    }), { headers: KUGOU_NO_CACHE_HEADERS })
    const rawAlbums = infoList(body)
    for (const item of rawAlbums) {
      const albumId = String(item.albumid || item.album_id || item.id || '')
      if (!albumId || seen.has(albumId)) continue
      seen.add(albumId)
      albums.push({
        id: albumId,
        name: String(item.albumname || item.album_name || item.name || ''),
        artistName,
        publishDate: normalizeDate(item.publishtime || item.publish_time || item.publish_date || ''),
        songCount: Number(item.songcount || 0),
        coverUrl: String(item.imgurl || item.sizable_cover || '').replace('{size}', '500'),
        raw: item,
      })
    }
    if (!rawAlbums.length || rawAlbums.length < pageSize) break
  }
  return fetchAlbumDetails('kg', artistName, albums, async (seed, index) => {
    progress?.({ platform: 'kg', stage: 'album', current: index + 1, total: albums.length, message: `酷狗音乐：抓取 ${seed.name}` })
    const body = await fetchJson<any>(`https://mobiles.kugou.com/api/v3/album/song?version=9108&albumid=${seed.id}&plat=0&pagesize=1000&area_code=0&page=1&with_res_tag=0`)
    const rawSongs = infoList(body)
    return rawSongs.map((item: any, songIndex: number) => {
      const parsed = parseKugouSongArtistAndTitle(item)
      return makeSong({
        platform: 'kg',
        platformSongId: String(item.hash || item.audio_id || item.filename || `${seed.id}-${songIndex}`),
        title: parsed.title,
        artist: parsed.artist,
        albumId: stableId('kg:album', seed.id),
        albumName: seed.name,
        duration: Math.round(Number(item.duration || 0)),
        trackNo: songIndex + 1,
        coverUrl: item.img || item.cover || seed.coverUrl,
        qualitys: kugouQualitys(item),
        raw: { ...item, publishDate: seed.publishDate, albumSongCount: rawSongs.length || seed.songCount || 0, hash: item.hash || item.FileHash || item['320hash'] || item.sqhash },
      })
    })
  })
}

async function searchKugouSongs(query: string, limit: number): Promise<Song[]> {
  const body = await fetchJson<any>(`https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(query)}&page=1&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`)
  const rawSongs = body?.data?.lists || []
  return rawSongs.map((item: any, index: number) => makeSong({
    platform: 'kg',
    platformSongId: String(item.Audioid || item.audio_id || item.FileHash || item.hash || `${query}-${index}`),
    title: cleanKugouTitle(item.SongName || item.songname || item.filename || item.FileName || ''),
    artist: formatArtistNames(item.Singers) || item.SingerName || item.singername || '',
    albumId: stableId('kg:album', item.AlbumID || item.album_id || item.AlbumName || ''),
    albumName: item.AlbumName || item.albumname || '',
    duration: Math.round(Number(item.Duration || item.duration || 0)),
    trackNo: index + 1,
    coverUrl: String(item.Image || item.img || '').replace('{size}', '500'),
    qualitys: kugouSearchQualitys(item),
    raw: {
      ...item,
      hash: item.FileHash || item.hash,
      '320hash': item.HQFileHash || item['320hash'],
      sqhash: item.SQFileHash || item.sqhash,
      hash_high: item.ResFileHash || item.hash_high,
      audio_id: item.Audioid || item.audio_id,
      album_audio_id: item.AlbumAudioId || item.album_audio_id,
      albumSongCount: 0,
    },
  }))
}

async function fetchQQAlbums(artistName: string, progress?: ProgressCallback): Promise<Album[]> {
  const artist = await resolveQQSinger(artistName)
  if (!artist?.mid) throw new Error('未找到歌手')
  const albums = await fetchQQAlbumSeeds(artist.mid, artistName)
  return fetchAlbumDetails('tx', artistName, albums, async (seed, index) => {
    progress?.({ platform: 'tx', stage: 'album', current: index + 1, total: albums.length, message: `QQ音乐：抓取 ${seed.name}` })
    return fetchQQAlbumSongs(seed, artistName, artist.mid)
  })
}

async function searchQQSongs(query: string, limit: number): Promise<Song[]> {
  const body = await qqGetJson<any>(QQ_SEARCH_URL, {
    w: query,
    p: 1,
    n: limit,
    cr: 1,
    t: 0,
    format: 'json',
    remoteplace: 'txt.yqq.song',
  }, `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(query)}`)
  const rawSongs = body?.data?.song?.list || []
  return rawSongs.map((item: any, index: number) => extractQQSong(item, {
    id: String(item?.album?.mid || item?.albummid || item?.albumid || ''),
    mid: String(item?.album?.mid || item?.albummid || ''),
    name: String(item?.album?.name || item?.albumname || ''),
    artistName: formatArtistNames(item?.singer || item?.singers) || '',
    raw: item?.album || {},
  }, formatArtistNames(item?.singer || item?.singers) || '', '', 0, index + 1)).filter((song: Song | null): song is Song => !!song)
}

async function resolveQQSinger(artistName: string): Promise<{ mid: string; name: string }> {
  const text = String(artistName || '').trim()
  if (text.toLowerCase().startsWith('mid:')) return { mid: text.slice(4).trim(), name: artistName }
  if (/^[0-9A-Za-z_-]{10,}$/.test(text)) return { mid: text, name: artistName }
  const singers = await searchQQSingers(artistName)
  if (!singers.length) throw new Error('未找到歌手')
  const target = normalizeCompareText(artistName)
  return singers.find((singer) => normalizeCompareText(singer.name) === target) || singers[0]
}

async function searchQQSingers(keyword: string): Promise<Array<{ mid: string; name: string }>> {
  const searchReferer = `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(keyword)}`
  const smartbox = await qqGetJson<any>(QQ_SMARTBOX_URL, { key: keyword }, searchReferer)
  const smartboxSingers = smartbox?.data?.singer?.itemlist || []
  const singers = smartboxSingers.map((item: any) => ({
    mid: String(firstRawValue(item, ['mid', 'singermid', 'singer_mid'], '')).trim(),
    name: String(firstRawValue(item, ['name', 'singer'], '')).trim(),
  })).filter((item: { mid: string; name: string }) => item.mid && item.name)
  if (singers.length) return singers

  try {
    const legacy = await qqGetJson<any>(QQ_SEARCH_URL, {
      w: keyword,
      p: 1,
      n: 20,
      cr: 1,
      t: 9,
      remoteplace: 'txt.yqq.singer',
    }, searchReferer)
    const legacySingers = legacy?.data?.singer?.list || []
    return legacySingers.map((item: any) => ({
      mid: String(firstRawValue(item, ['singermid', 'singerMID', 'singerMid', 'singer_mid', 'mid', 'Fsinger_mid'], '')).trim(),
      name: String(firstRawValue(item, ['singername', 'singerName', 'name', 'Fsinger_name', 'singer_name'], '')).trim(),
    })).filter((item: { mid: string; name: string }) => item.mid && item.name)
  } catch {
    return []
  }
}

async function fetchQQAlbumSeeds(singerMid: string, artistName: string): Promise<RawAlbumSeed[]> {
  const result: RawAlbumSeed[] = []
  const seen = new Set<string>()
  let begin = 0
  let total: number | null = null
  while (true) {
    const body = await musicu<any>({
      comm: { ct: 24, cv: 10000 },
      singerAlbum: {
        module: 'music.web_singer_info_svr',
        method: 'get_singer_album',
        param: {
          singermid: singerMid,
          order: 'time',
          begin,
          num: QQ_ALBUM_PAGE_SIZE,
          exstatus: 1,
        },
      },
    }, `https://y.qq.com/n/ryqq/singer/${singerMid}`)
    const data = body?.singerAlbum?.data || {}
    const rawAlbums = data.list || data.albumList || []
    if (total == null) total = toInt(firstRawValue(data, ['total', 'totalNum', 'total_num'], rawAlbums.length), rawAlbums.length)
    if (!rawAlbums.length) break
    for (const rawAlbum of rawAlbums) {
      const seed = extractQQAlbumSeed(rawAlbum, artistName, singerMid)
      if (!seed.id || !seed.name || seen.has(seed.id)) continue
      seen.add(seed.id)
      result.push(seed)
    }
    begin += rawAlbums.length
    if (begin >= (total || 0) || rawAlbums.length < QQ_ALBUM_PAGE_SIZE) break
  }
  return result
}

function extractQQAlbumSeed(item: any, artistName: string, singerMid: string): RawAlbumSeed {
  const albumMid = String(firstRawValue(item, ['album_mid', 'albumMid', 'albummid', 'mid', 'Falbum_mid', 'albumMID'], '')).trim()
  const albumId = String(firstRawValue(item, ['album_id', 'albumID', 'albumId', 'albumid', 'id', 'Falbum_id'], '')).trim()
  const name = String(firstRawValue(item, ['album_name', 'albumName', 'albumname', 'name', 'Falbum_name'], '')).trim()
  const publishTime = String(firstRawValue(item, ['publish_time', 'publishTime', 'publish_date', 'public_time', 'publicTime', 'pub_time', 'pubTime', 'Fpublic_time', 'date'], '')).trim()
  const latestSong = item?.latest_song
  const songCount = toInt(firstRawValue(item, ['song_count', 'songCount', 'song_num', 'songNum', 'total_song_num', 'totalSongNum', 'songnum', 'Fsong_num'], 0)) ||
    (latestSong && typeof latestSong === 'object' ? toInt(latestSong.song_count) : 0)
  return {
    id: albumMid || albumId,
    mid: albumMid,
    name,
    artistName,
    publishDate: normalizeDate(publishTime),
    songCount,
    coverUrl: albumMid ? `https://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg` : '',
    raw: { ...item, album_mid: albumMid, album_id: albumId, singer_mid: singerMid },
  }
}

async function fetchQQAlbumSongs(seed: RawAlbumSeed, artistName: string, singerMid: string): Promise<Song[]> {
  const body = await musicu<any>({
    comm: { ct: 24, cv: 10000 },
    albumSonglist: {
      module: 'music.musichallAlbum.AlbumSongList',
      method: 'GetAlbumSongList',
      param: {
        albumMid: seed.mid || '',
        albumID: toInt(seed.raw?.album_id),
        begin: 0,
        num: 999,
        order: 2,
      },
    },
  }, seed.mid ? `https://y.qq.com/n/ryqq/albumDetail/${seed.mid}` : QQ_REFERER)
  const data = body?.albumSonglist?.data || {}
  const rawSongs: any[] = data.songList || data.songlist || data.list || []
  const albumSongCount = toInt(firstRawValue(data, ['totalNum', 'total_num', 'total'], 0)) || rawSongs.length || seed.songCount || 0
  return rawSongs.map((item: any, index: number) => extractQQSong(item, seed, artistName, singerMid, albumSongCount, index + 1)).filter((song): song is Song => !!song)
}

function extractQQSong(songItem: any, album: RawAlbumSeed, artistName: string, singerMid: string, albumSongCount: number, index: number): Song | null {
  const song = songItem?.songInfo || songItem?.song_info || songItem?.song || songItem
  const singers = song?.singer || song?.singers || []
  const sourceArtists = Array.isArray(singers)
    ? singers.map((item) => String(firstRawValue(item, ['name', 'singer_name', 'title'], '')).trim()).filter(Boolean)
    : []
  const sourceMids = Array.isArray(singers)
    ? singers.map((item) => normalizeSingerMid(firstRawValue(item, ['mid', 'singer_mid', 'singerMid'], ''))).filter(Boolean)
    : []
  const targetMid = normalizeSingerMid(singerMid)
  if (!sourceArtists.length && !sourceMids.length) return null

  const hasNameMatch = sourceArtists.some((artist) => artistMatches(artistName, artist))
  const hasMidMatch = !!targetMid && sourceMids.includes(targetMid)
  if ((sourceArtists.length || sourceMids.length) && !(hasNameMatch || hasMidMatch)) return null

  const songMid = String(firstRawValue(song, ['mid', 'songmid', 'songMid'], '')).trim()
  const title = String(firstRawValue(song, ['name', 'songname', 'songName', 'title', 'songorig', 'songOrig'], '')).trim()
  if (!songMid || !title) return null
  const albumObj = song.album && typeof song.album === 'object' ? song.album : {}
  const albumName = String(firstRawValue(albumObj, ['name', 'title'], '') || album.name).trim()
  const albumMid = String(firstRawValue(albumObj, ['mid'], '') || album.mid || album.id).trim()
  const publishDate = normalizeDate(firstRawValue(song, ['time_public', 'pub_time'], '') || album.publishDate || '')
  return makeSong({
    platform: 'tx',
    platformSongId: songMid,
    title,
    artist: sourceArtists.join(' / '),
    albumId: stableId('tx:album', albumMid || album.id),
    albumName,
    duration: Number(song.interval || 0),
    trackNo: index,
    coverUrl: albumMid ? `https://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg` : album.coverUrl,
    qualitys: qqQualitys(song.file || {}),
    raw: { ...song, song_id: firstRawValue(song, ['id', 'songid', 'songId'], ''), publishDate, albumSongCount },
  })
}

async function fetchKuwoAlbums(artistName: string, progress?: ProgressCallback): Promise<Album[]> {
  const albums = await fetchKuwoAlbumsBySearchQuery(artistName, artistName, progress)
  if (albums.length) return albums
  for (const query of await resolveKuwoAliasQueries(artistName)) {
    if (normalizeCompareText(query) === normalizeCompareText(artistName)) continue
    const aliasAlbums = await fetchKuwoAlbumsBySearchQuery(artistName, query, progress)
    if (aliasAlbums.length) return aliasAlbums
  }
  return albums
}

async function fetchKuwoAlbumsBySearchQuery(artistName: string, searchQuery: string, progress?: ProgressCallback): Promise<Album[]> {
  const grouped = new Map<string, { seed: RawAlbumSeed; songs: Song[] }>()
  for (let page = 0; page < KUWO_MAX_PAGES; page++) {
    progress?.({ platform: 'kw', stage: 'songs', current: page + 1, total: KUWO_MAX_PAGES, message: '酷我音乐：搜索并聚合专辑' })
    let items: any[]
    try {
      ;({ items } = await fetchKuwoSearchPage(searchQuery, page))
    } catch (error) {
      if (grouped.size > 0) break
      throw error
    }
    if (!items.length) break
    for (const item of items) {
      const singer = decodeHtml(item.ARTIST || item.artist || '')
      if (!artistMatches(artistName, singer)) continue
      const albumName = decodeHtml(item.ALBUM || item.album || '')
      if (!albumName) continue
      const albumId = String(item.ALBUMID || item.albumid || albumName)
      let group = grouped.get(albumId)
      if (!group) {
        group = {
          seed: {
            id: albumId,
            name: albumName,
            artistName,
            publishDate: normalizeDate(firstRawValue(item, KUWO_DATE_KEYS, '')),
            songCount: 0,
            coverUrl: kuwoCoverUrl(item),
            raw: { searchItems: [], search_items: [] },
          },
          songs: [],
        }
        grouped.set(albumId, group)
      }
      group.songs.push(makeSong({
        platform: 'kw',
        platformSongId: String(item.MUSICRID || item.musicrid || item.DC_TARGETID || item.rid || item.id || '').replace('MUSIC_', ''),
        title: decodeHtml(item.SONGNAME || item.name || item.songname || ''),
        artist: singer || artistName,
        albumId: stableId('kw:album', albumId),
        albumName,
        duration: Number(item.DURATION || item.duration || 0),
        trackNo: group.songs.length + 1,
        coverUrl: kuwoCoverUrl(item) || group.seed.coverUrl,
        qualitys: ['128k', '320k', 'flac'],
        raw: { ...item, publishDate: group.seed.publishDate, publish_date: group.seed.publishDate, albumSongCount: 0 },
      }))
      ;(group.seed.raw?.searchItems as unknown[]).push(item)
      ;(group.seed.raw?.search_items as unknown[]).push(item)
    }
    if (items.length < KUWO_PAGE_SIZE) break
  }

  const albums: Album[] = []
  for (const group of grouped.values()) {
    const enriched = await enrichKuwoAlbum(group.seed, group.songs).catch(() => group.seed)
    albums.push(makeAlbum('kw', artistName, enriched, group.songs))
  }
  return albums
}

async function resolveKuwoAliasQueries(artistName: string): Promise<string[]> {
  try {
    const singers = await searchQQSingers(artistName)
    return unique(singers.map((singer) => singer.name).filter((name) => artistMatches(artistName, name)))
  } catch {
    return []
  }
}

async function searchKuwoSongs(query: string, limit: number): Promise<Song[]> {
  const body = await fetchJson<any>(`https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(query)}&pn=0&rn=${limit}&uid=0&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1`)
  const items = body?.abslist || body?.list || []
  return items.map((item: any, index: number) => {
    const albumName = decodeHtml(item.ALBUM || item.album || '')
    const albumId = String(item.ALBUMID || item.albumid || albumName)
    return makeSong({
      platform: 'kw',
      platformSongId: String(item.MUSICRID || item.musicrid || item.DC_TARGETID || item.rid || item.id || '').replace('MUSIC_', ''),
      title: decodeHtml(item.SONGNAME || item.name || item.songname || ''),
      artist: decodeHtml(item.ARTIST || item.artist || ''),
      albumId: stableId('kw:album', albumId),
      albumName,
      duration: Number(item.DURATION || item.duration || 0),
      trackNo: index + 1,
      coverUrl: kuwoCoverUrl(item),
      qualitys: ['128k', '320k', 'flac'],
      raw: { ...item, publishDate: normalizeDate(firstRawValue(item, KUWO_DATE_KEYS, '')), albumSongCount: 0 },
    })
  })
}

async function fetchKuwoSearchPage(artistName: string, page: number): Promise<{ items: any[]; total: number }> {
  let lastResult: { items: any[]; total: number } = { items: [], total: 0 }
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    const body = await fetchJson<any>(`https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(artistName)}&pn=${page}&rn=${KUWO_PAGE_SIZE}&uid=0&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1`)
    const items = body?.abslist || body?.list || []
    const total = toInt(body?.TOTAL ?? body?.total, items.length)
    lastResult = { items, total }
    const shouldRetryEmptyPage = !items.length && (page === 0 || total > page * KUWO_PAGE_SIZE)
    if (!shouldRetryEmptyPage || attempt === FETCH_ATTEMPTS - 1) return lastResult
    await waitForRetry(attempt)
  }
  return lastResult
}

async function enrichKuwoAlbum(seed: RawAlbumSeed, songs: Song[]): Promise<RawAlbumSeed> {
  if (!seed.id) return seed
  const detail = await fetchJson<any>(`http://search.kuwo.cn/r.s?pn=0&rn=20&stype=albuminfo&albumid=${encodeURIComponent(seed.id)}&show_copyright_off=0&encoding=utf&vipver=MUSIC_9.1.0`)
  const detailSongs = detail?.musiclist || []
  const publishDate = normalizeDate(firstRawValue(detail, KUWO_DATE_KEYS, '')) ||
    firstDetailSongDate(detailSongs) ||
    seed.publishDate ||
    ''
  const songCount = toInt(detail?.songnum) || seed.songCount || songs.length
  const coverUrl = kuwoCoverUrl(detail) || seed.coverUrl
  songs.forEach((song, index) => {
    const detailSong = detailSongs[index] && typeof detailSongs[index] === 'object' ? detailSongs[index] : {}
    const songPublishDate = normalizeDate(firstRawValue(detailSong, KUWO_DATE_KEYS, '')) || publishDate
    song.raw.publishDate = songPublishDate
    song.raw.publish_date = songPublishDate
    song.raw.detailPublishDate = publishDate
    song.raw.detail_publish_date = publishDate
    song.raw.albumSongCount = songCount
    if (coverUrl && !song.coverUrl) song.coverUrl = coverUrl
  })
  return {
    ...seed,
    publishDate,
    songCount,
    coverUrl,
    raw: {
      ...(seed.raw || {}),
      detailPublishDate: publishDate,
      detail_publish_date: publishDate,
      detailSongCount: songCount,
      detail_song_count: songCount,
      detailCoverUrl: coverUrl,
      detail_cover_url: coverUrl,
    },
  }
}

async function fetchAlbumDetails(
  platform: Platform,
  artistName: string,
  seeds: RawAlbumSeed[],
  fetchSongs: (seed: RawAlbumSeed, index: number) => Promise<Song[]>,
): Promise<Album[]> {
  const albums: Array<Album | undefined> = new Array(seeds.length)
  let nextIndex = 0
  const workerCount = Math.min(albumDetailConcurrency(platform), seeds.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex++
      const seed = seeds[index]
      if (!seed) return
      const songs = await fetchAlbumSongsWithRetry(seed, index, fetchSongs)
      albums[index] = makeAlbum(platform, artistName, seed, songs)
    }
  })
  await Promise.all(workers)
  return albums.filter((album): album is Album => Boolean(album))
}

function albumDetailConcurrency(platform: Platform): number {
  if (platform === 'wy') return NETEASE_ALBUM_DETAIL_CONCURRENCY
  return platform === 'kg' ? KUGOU_ALBUM_DETAIL_CONCURRENCY : DEFAULT_ALBUM_DETAIL_CONCURRENCY
}

async function fetchAlbumSongsWithRetry(
  seed: RawAlbumSeed,
  index: number,
  fetchSongs: (seed: RawAlbumSeed, index: number) => Promise<Song[]>,
  waitForRetryFn: (attempt: number) => Promise<void> = waitForRetry,
): Promise<Song[]> {
  let lastSongs: Song[] = []
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const songs = await fetchSongs(seed, index)
      lastSongs = songs
      const shouldRetryEmptyDetail = !songs.length && Number(seed.songCount || 0) > 0
      if (!shouldRetryEmptyDetail || attempt === FETCH_ATTEMPTS - 1) return songs
    } catch (error) {
      if (attempt === FETCH_ATTEMPTS - 1) throw error
    }
    await waitForRetryFn(attempt)
  }
  return lastSongs
}

function filterArtistAlbums(artistName: string, albums: Album[]): Album[] {
  return albums.map((album) => {
    const songs = album.songs.filter((song) => artistMatches(artistName, song.artist))
    songs.forEach((song) => {
      song.raw.albumSongCount = songs.length
    })
    return { ...album, songs, songCount: songs.length }
  }).filter((album) => album.songs.length > 0)
}

function makeAlbum(platform: Platform, artistName: string, seed: RawAlbumSeed, songs: Song[]): Album {
  return {
    id: stableId(`${platform}:album`, seed.id || seed.name),
    platform,
    platformAlbumId: String(seed.id || seed.mid || seed.name),
    artistName,
    name: seed.name || '未知专辑',
    publishDate: normalizeDate(seed.publishDate || ''),
    songCount: seed.songCount || songs.length,
    coverUrl: seed.coverUrl || songs[0]?.coverUrl || '',
    songs,
    raw: seed.raw || {},
  }
}

function makeSong(info: Omit<Song, 'id'>): Song {
  return {
    ...info,
    id: stableId(`${info.platform}:song`, info.platformSongId, info.albumName),
    title: String(info.title || '').trim() || '未命名歌曲',
    artist: String(info.artist || '').trim(),
    albumName: String(info.albumName || '').trim() || '未知专辑',
    qualitys: info.qualitys?.length ? info.qualitys : ['flac24bit', 'flac', '320k', '128k'],
    raw: info.raw || {},
  }
}

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
      })
      if (!response.ok) throw httpError(response.status, url)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt === FETCH_ATTEMPTS - 1 || !isRetryableFetchError(error)) throw error
      await waitForRetry(attempt)
    }
  }
  throw lastError
}

async function musicu<T>(payload: Record<string, unknown>, referer = QQ_REFERER): Promise<T> {
  return qqGetJson<T>(QQ_MUSICU_URL, {
    data: JSON.stringify(payload),
  }, referer)
}

async function qqGetJson<T>(url: string, params: Record<string, unknown>, referer = QQ_REFERER): Promise<T> {
  return fetchJson<T>(withQuery(url, {
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    g_tk: 5381,
    ...params,
  }), { headers: { Referer: referer } })
}

async function neteaseEapi<T>(url: string, data: Record<string, unknown>): Promise<T> {
  const form = new URLSearchParams(neteaseEapiPayload(url, data))
  return fetchJson<T>(NETEASE_EAPI_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      Origin: 'https://music.163.com',
      Referer: 'https://music.163.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })
}

function neteaseEapiPayload(url: string, data: Record<string, unknown>): Record<string, string> {
  const text = JSON.stringify(data)
  const message = `nobody${url}use${text}md5forencrypt`
  const digest = crypto.createHash('md5').update(message).digest('hex')
  const payload = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  const cipher = crypto.createCipheriv('aes-128-ecb', NETEASE_EAPI_KEY, null)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()])
  return { params: encrypted.toString('hex').toUpperCase() }
}

function unwrapNeteaseEapiBody<T>(body: T | { body?: T }): T {
  if (body && typeof body === 'object' && 'body' in body && (body as { body?: T }).body) return (body as { body: T }).body
  return body as T
}

function withQuery(url: string, params: Record<string, unknown>): string {
  const endpoint = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    endpoint.searchParams.set(key, String(value))
  }
  return endpoint.toString()
}

function httpError(status: number, url: string): Error & { status: number; retryable: boolean } {
  const error = new Error(`HTTP ${status} ${url}`) as Error & { status: number; retryable: boolean }
  error.status = status
  error.retryable = status === 408 || status === 425 || status === 429 || status >= 500
  return error
}

function isRetryableFetchError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) return Boolean((error as { retryable?: unknown }).retryable)
  return true
}

async function waitForRetry(attempt: number): Promise<void> {
  const delay = FETCH_RETRY_DELAYS_MS[attempt] || 0
  if (delay <= 0) return
  await platformFetchRuntime.sleep(delay)
}

async function waitForNeteaseAlbumDetailRetry(attempt: number): Promise<void> {
  const delay = NETEASE_ALBUM_DETAIL_RETRY_DELAYS_MS[attempt] || 0
  if (delay <= 0) return
  await platformFetchRuntime.sleep(delay)
}

function randomDelay(range: readonly [number, number]): number {
  return platformFetchRuntime.randomInt(range[0], range[1])
}

function isRateLimitLikeError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /429|too many requests|timeout|forbidden|风控/i.test(text)
}

function infoList(data: any): any[] {
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.data?.info)) return data.data.info
  if (Array.isArray(data?.info)) return data.info
  return []
}

function formatArtistNames(value: any): string {
  if (Array.isArray(value)) return value.map((item) => item.name || item.author_name || item.singerName || '').filter(Boolean).join('、')
  return String(value || '')
}

function splitArtistNames(value: string): string[] {
  const text = String(value || '').trim()
  if (!text) return []
  return text.split(/\s*(?:\/|、|,|，|;|；|\||&|＆|\+| feat\.? | ft\.? | with | x )\s*/i).map((item) => item.trim()).filter(Boolean)
}

function artistMatches(targetArtist: string, candidateArtist: string): boolean {
  const target = normalizeCompareText(targetArtist)
  if (!target) return false
  const targetWithoutLatinAlias = stripLatinAlias(target)
  return splitArtistNames(candidateArtist).some((part) => {
    const candidate = normalizeCompareText(part)
    if (candidate === target) return true
    const candidateWithoutLatinAlias = stripLatinAlias(candidate)
    return hasCjkText(targetWithoutLatinAlias) &&
      candidateWithoutLatinAlias === targetWithoutLatinAlias
  })
}

function stripLatinAlias(value: string): string {
  return value.replace(/[a-z0-9]+/g, '')
}

function hasCjkText(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value)
}

function kugouQualitys(item: any): Quality[] {
  const result: Quality[] = []
  if (item.hash_high || item.filesize_high) result.push('flac24bit')
  if (item.sqhash || item.hash_flac || item.filesize_flac) result.push('flac')
  if (item['320hash'] || item.filesize_320 || item.filesize_320mp3) result.push('320k')
  result.push('128k')
  return unique(result)
}

function kugouSearchQualitys(item: any): Quality[] {
  const result: Quality[] = []
  if (item.ResFileHash || item.ResFileSize || item.hash_high || item.filesize_high) result.push('flac24bit')
  if (item.SQFileHash || item.SQFileSize || item.sqhash || item.hash_flac || item.filesize_flac) result.push('flac')
  if (item.HQFileHash || item.HQFileSize || item['320hash'] || item.filesize_320 || item.filesize_320mp3) result.push('320k')
  result.push('128k')
  return unique(result)
}

function qqQualitys(file: any): Quality[] {
  const result: Quality[] = []
  if (Number(file.size_hires || 0) > 0) result.push('flac24bit')
  if (Number(file.size_flac || 0) > 0) result.push('flac')
  if (Number(file.size_320mp3 || 0) > 0) result.push('320k')
  if (Number(file.size_128mp3 || 0) > 0) result.push('128k')
  return result.length ? result : ['128k', '320k', 'flac']
}

function cleanKugouTitle(value: string): string {
  const text = String(value || '')
  return text.includes(' - ') ? text.split(' - ').slice(1).join(' - ') : text
}

function parseKugouSongArtistAndTitle(item: any): { artist: string; title: string } {
  const explicitArtist = String(item.singername || item.SingerName || item.singerName || item.author_name || '').trim()
  const rawTitle = String(item.filename || item.songname || item.name || item.SongName || '').trim()
  if (explicitArtist) return { artist: explicitArtist, title: cleanKugouTitle(rawTitle) }
  if (rawTitle.includes(' - ')) {
    const [artist, ...titleParts] = rawTitle.split(' - ')
    const title = titleParts.join(' - ').trim()
    return { artist: artist.trim(), title: title || rawTitle }
  }
  return { artist: '', title: rawTitle }
}

function decodeHtml(value: unknown): string {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
}

function normalizeDate(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const timestamp = Number(raw)
  if (/^\d+$/.test(raw) && Number.isFinite(timestamp) && timestamp > 10_000_000) return dateFromMs(timestamp)
  const match = raw.match(/\d{4}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2})?/)
  if (!match) return raw.slice(0, 20)
  const parts = match[0].split(/[-/.年月]/).filter(Boolean)
  const year = parts[0] || ''
  const month = parts[1] || '1'
  const day = parts[2] || '1'
  if (!year) return ''
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function dateFromMs(value: unknown): string {
  let ms = Number(value || 0)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 10_000_000_000) ms *= 1000
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function firstDetailSongDate(detailSongs: unknown[]): string {
  for (const item of detailSongs) {
    if (!item || typeof item !== 'object') continue
    const value = normalizeDate(firstRawValue(item as Record<string, unknown>, KUWO_DATE_KEYS, ''))
    if (value) return value
  }
  return ''
}

function firstRawValue(obj: any, keys: string[], fallback: unknown = ''): unknown {
  if (!obj || typeof obj !== 'object') return fallback
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return fallback
}

function kuwoCoverUrl(item: any): string {
  const pic = String(item?.web_albumpic_short || item?.albumpic || item?.pic || item?.img || item?.hts_img || '')
  if (!pic) return ''
  if (pic.startsWith('http')) return pic
  return `https://img4.kuwo.cn/star/albumcover/${pic.replace(/^\/+/, '')}`
}

function normalizeSingerMid(value: unknown): string {
  const text = String(value || '').trim()
  return text.toLowerCase().startsWith('mid:') ? text.slice(4).trim() : text
}

function toInt(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function stableId(...parts: unknown[]): string {
  return crypto.createHash('sha1').update(parts.map((part) => String(part ?? '')).join('\x1f')).digest('hex')
}
