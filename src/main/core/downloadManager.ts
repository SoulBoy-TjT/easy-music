import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { extForQuality, readNumber, readPublishDate, resolveSongFilePath } from './naming'
import { enhanceCoverUrl, writeMetadata } from './metadata'
import { normalizeDownloadRequest } from './sourceBridge'
import { applyPathRenames, normalizeDownloadedFoldersWithCleanup } from './folderCounts'
import { validateDownloadedAudioFile as validateAudioFile } from './audioValidation'
import { PLATFORM_LABELS, type CandidateSource, type DownloadRequest, type DownloadStore, type DownloadTask, type Platform, type Quality, type Song, type UrlResolver } from './types'

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
  Accept: '*/*',
}
const REFRESH_STATUSES = new Set([401, 403, 410])
const FALLBACK_HTTP_STATUSES = new Set([401, 403, 404, 410, 429, 500, 502, 503, 504])
const QUALITY_ORDER: Quality[] = ['flac24bit', 'flac', '320k', '128k']
const SEARCH_FALLBACK_PLATFORMS: Platform[] = ['kg', 'tx', 'wy', 'kw']

export class DownloadManager {
  private cancelled = false
  private readonly activeCancelers = new Set<() => void>()

  constructor(
    private readonly store: DownloadStore,
    private readonly resolver: UrlResolver,
    private readonly downloadRoot: string,
    private readonly maxConcurrent = 3,
  ) {}

  cancel(): void {
    this.cancelled = true
    for (const cancel of Array.from(this.activeCancelers)) cancel()
  }

  async runPending(taskIds: string[] = []): Promise<void> {
    this.cancelled = false
    const selected = new Set(taskIds)
    const tasks = this.store.listDownloadTasks(['waiting'])
      .filter((task) => !selected.size || selected.has(task.id))
      .sort((left, right) => {
        if (!taskIds.length) return 0
        return taskIds.indexOf(left.id) - taskIds.indexOf(right.id)
      })
    const batchArtistNames = Array.from(new Set(tasks.map((task) => task.playlistArtistName).filter(Boolean)))
    const workers = Array.from({ length: Math.max(1, this.maxConcurrent) }, async () => {
      while (tasks.length && !this.cancelled) {
        const task = tasks.shift()
        if (task) await this.runTask(task)
      }
    })
    await Promise.all(workers)
    this.normalizeBatchFolders(batchArtistNames)
  }

  private async runTask(task: DownloadTask): Promise<void> {
    if (this.cancelled) {
      this.store.updateDownloadTask(task.id, { status: 'cancelled', statusText: '已暂停', speed: '' })
      return
    }
    const attempts = buildAttempts(task)
    const errors: string[] = []
    this.store.updateDownloadTask(task.id, { status: 'running', statusText: '获取下载地址', error: '' })
    for (const attempt of attempts) {
      try {
        this.store.updateDownloadTask(task.id, { statusText: `${platformLabel(attempt.platform)} / ${attempt.quality} 获取下载地址` })
        const request = await this.getDownloadRequest(attempt.song, attempt.quality, false)
        try {
          await this.downloadWithRequest(task, attempt.song, attempt.quality, request)
        } catch (error) {
          if (error instanceof DownloadHttpStatusError && REFRESH_STATUSES.has(error.statusCode)) {
            this.store.updateDownloadTask(task.id, { statusText: `${platformLabel(attempt.platform)} / ${attempt.quality} 链接失效，刷新中` })
            await this.downloadWithRequest(task, attempt.song, attempt.quality, await this.getDownloadRequest(attempt.song, attempt.quality, true))
          } else {
            throw error
          }
        }

        const musicInfo = toLxMusicInfo(attempt.song, attempt.quality)
        const [lyrics, pic] = await Promise.all([
          this.resolver.requestLyric(attempt.song.platform, musicInfo).catch(() => null),
          this.resolver.requestPic(attempt.song.platform, musicInfo).catch(() => null),
        ])
        const filePath = this.store.listDownloadTasks().find((item) => item.id === task.id)?.filePath || task.filePath
        await writeMetadata(filePath, task.song, lyrics, enhanceCoverUrl(pic || attempt.song.coverUrl || task.song.coverUrl || ''))
        try {
          validateAudioFile(filePath, extForQuality(attempt.quality))
        } catch (error) {
          fs.rmSync(filePath, { force: true })
          throw error
        }
        this.store.updateDownloadTask(task.id, { status: 'success', statusText: '下载成功', speed: '', error: '' })
        return
      } catch (error) {
        if (error instanceof CancelledDownloadError) {
          this.store.updateDownloadTask(task.id, { status: 'cancelled', statusText: '已暂停', speed: '' })
          return
        }
        errors.push(formatAttemptError(attempt.platform, attempt.song.platformSongId, attempt.quality, error))
        if (!shouldTryNextAttempt(error)) break
      }
    }
    if (await this.runSearchFallback(task, attempts, errors)) return
    this.store.updateDownloadTask(task.id, {
      status: 'failed',
      statusText: '下载失败',
      speed: '',
      downloaded: 0,
      total: 0,
      filePath: '',
      error: errors.join('；') || '没有可用下载地址',
    })
  }

  private async getDownloadRequest(song: Song, quality: Quality, refresh: boolean): Promise<DownloadRequest> {
    const value = await this.resolver.requestMusicUrl(song.platform, toLxMusicInfo(song, quality), quality, refresh)
    return normalizeDownloadRequest(value)
  }

  private async runSearchFallback(
    task: DownloadTask,
    existingAttempts: Array<{ platform: Platform; quality: Quality; song: Song }>,
    errors: string[],
  ): Promise<boolean> {
    const fallbackAttempts = await this.buildSearchFallbackAttempts(task, existingAttempts, errors)
    for (const attempt of fallbackAttempts) {
      try {
        this.store.updateDownloadTask(task.id, { statusText: `搜索兜底：${platformLabel(attempt.platform)} / ${attempt.quality} 鑾峰彇涓嬭浇鍦板潃` })
        const request = await this.getDownloadRequest(attempt.song, attempt.quality, false)
        try {
          await this.downloadWithRequest(task, attempt.song, attempt.quality, request)
        } catch (error) {
          if (error instanceof DownloadHttpStatusError && REFRESH_STATUSES.has(error.statusCode)) {
            this.store.updateDownloadTask(task.id, { statusText: `搜索兜底：${platformLabel(attempt.platform)} / ${attempt.quality} 閾炬帴澶辨晥锛屽埛鏂颁腑` })
            await this.downloadWithRequest(task, attempt.song, attempt.quality, await this.getDownloadRequest(attempt.song, attempt.quality, true))
          } else {
            throw error
          }
        }
        const musicInfo = toLxMusicInfo(attempt.song, attempt.quality)
        const [lyrics, pic] = await Promise.all([
          this.resolver.requestLyric(attempt.song.platform, musicInfo).catch(() => null),
          this.resolver.requestPic(attempt.song.platform, musicInfo).catch(() => null),
        ])
        const filePath = this.store.listDownloadTasks().find((item) => item.id === task.id)?.filePath || task.filePath
        await writeMetadata(filePath, task.song, lyrics, enhanceCoverUrl(pic || attempt.song.coverUrl || task.song.coverUrl || ''))
        try {
          validateAudioFile(filePath, extForQuality(attempt.quality))
        } catch (error) {
          fs.rmSync(filePath, { force: true })
          throw error
        }
        this.store.updateDownloadTask(task.id, { status: 'success', statusText: '涓嬭浇鎴愬姛', speed: '', error: '搜索兜底下载成功' })
        return true
      } catch (error) {
        errors.push(`搜索兜底：${formatAttemptError(attempt.platform, attempt.song.platformSongId, attempt.quality, error)}`)
        if (!shouldTryNextAttempt(error)) break
      }
    }
    return false
  }

  private async buildSearchFallbackAttempts(
    task: DownloadTask,
    existingAttempts: Array<{ platform: Platform; quality: Quality; song: Song }>,
    errors: string[],
  ): Promise<Array<{ platform: Platform; quality: Quality; song: Song }>> {
    if (!this.resolver.searchSongs) return []
    const primaryQuery = buildSearchQuery(task.song, true)
    let searched = await this.resolver.searchSongs(primaryQuery, SEARCH_FALLBACK_PLATFORMS, 20).catch((error) => {
      errors.push(`搜索兜底失败：${formatDownloadError(error)}`)
      return []
    })
    let matches = mergeSearchFallbackMatches(
      filterSearchFallbackMatches(task.song, searched, true),
      filterSearchFallbackMatches(task.song, searched, false),
    )
    if (!matches.length && !searched.length) {
      searched = await this.resolver.searchSongs(buildSearchQuery(task.song, false), SEARCH_FALLBACK_PLATFORMS, 20).catch((error) => {
        errors.push(`搜索兜底失败：${formatDownloadError(error)}`)
        return []
      })
      matches = filterSearchFallbackMatches(task.song, searched, false)
    }
    if (!matches.length) {
      errors.push('搜索兜底未找到严格匹配歌曲')
      return []
    }

    const seen = new Set(existingAttempts.map((attempt) => `${attempt.song.platform}:${attempt.song.platformSongId}:${attempt.quality}`))
    const attempts: Array<{ platform: Platform; quality: Quality; song: Song }> = []
    for (const song of rankSearchFallbackMatches(task.song, matches)) {
      for (const quality of qualityFallbacks(task.quality, song.qualitys)) {
        const key = `${song.platform}:${song.platformSongId}:${quality}`
        if (seen.has(key)) continue
        seen.add(key)
        attempts.push({ platform: song.platform, quality, song })
      }
    }
    return attempts
  }

  private async downloadWithRequest(task: DownloadTask, sourceSong: Song, quality: Quality, request: DownloadRequest): Promise<void> {
    const ext = extForQuality(quality)
    const filePath = resolveSongFilePath(this.downloadRoot, task.playlistArtistName, task.song, ext, {
      publishDate: resolveTaskPublishDate(task, sourceSong),
      albumSongCount: readNumber(task.song.raw.albumSongCount) || readNumber(task.song.raw.album_song_count) || readNumber(sourceSong.raw.albumSongCount) || 1,
    })
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.store.updateDownloadTask(task.id, { statusText: '下载中', filePath, downloaded: 0, total: 0, speed: '' })
    let lastTick = Date.now()
    let lastDownloaded = 0
    await downloadToFile(request, filePath, (downloaded, total) => {
      const now = Date.now()
      let speed = ''
      if (now - lastTick >= 1000) {
        speed = formatBytes((downloaded - lastDownloaded) / ((now - lastTick) / 1000)) + '/s'
        lastTick = now
        lastDownloaded = downloaded
      }
      this.store.updateDownloadTask(task.id, {
        downloaded,
        total,
        speed,
      })
    }, () => this.cancelled, (cancel) => {
      this.activeCancelers.add(cancel)
      return () => this.activeCancelers.delete(cancel)
    })
    try {
      validateAudioFile(filePath, ext)
    } catch (error) {
      fs.rmSync(filePath, { force: true })
      throw error
    }
  }

  private normalizeBatchFolders(artistNames: string[]): void {
    const result = normalizeDownloadedFoldersWithCleanup(this.downloadRoot, artistNames)
    const invalidFiles = new Set(result.invalidFiles.map(normalizePath))
    for (const task of this.store.listDownloadTasks()) {
      if (!task.filePath) continue
      if (invalidFiles.has(normalizePath(task.filePath))) {
        this.store.updateDownloadTask(task.id, {
          status: 'failed',
          statusText: '下载失败',
          speed: '',
          downloaded: 0,
          total: 0,
          filePath: '',
          error: '文件已下载但不是可播放音频，已删除坏文件',
        })
        continue
      }
      const filePath = applyPathRenames(task.filePath, result.renames)
      if (filePath !== task.filePath) this.store.updateDownloadTask(task.id, { filePath })
    }
  }
}

export class DownloadHttpStatusError extends Error {
  constructor(readonly statusCode: number, url: string) {
    super(`HTTP ${statusCode}: ${url}`)
  }
}

export class CancelledDownloadError extends Error {
  constructor() {
    super('下载已暂停')
  }
}

function shouldTryNextAttempt(error: unknown): boolean {
  if (error instanceof DownloadHttpStatusError) return FALLBACK_HTTP_STATUSES.has(error.statusCode)
  return true
}

class InvalidAudioPayloadError extends Error {
  constructor(ext: string) {
    super(ext === 'mp3' ? '下载内容不是有效的 MP3 音频' : '下载内容不是有效的音频文件')
  }
}

function validateDownloadedAudioFile(filePath: string, ext: string): void {
  if (ext !== 'mp3') return
  const data = fs.readFileSync(filePath)
  let offset = 0
  if (data.subarray(0, 3).toString('ascii') === 'ID3' && data.length >= 10) {
    offset = 10 + synchsafeToInt(data.subarray(6, 10))
  }
  if (!isValidMp3FrameHeader(data, offset)) throw new InvalidAudioPayloadError(ext)
}

function synchsafeToInt(bytes: Buffer): number {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f)
}

function isValidMp3FrameHeader(data: Buffer, offset: number): boolean {
  if (offset < 0 || offset + 4 > data.length) return false
  const b1 = data[offset + 1]
  const b2 = data[offset + 2]
  return (
    data[offset] === 0xff &&
    (b1 & 0xe0) === 0xe0 &&
    ((b1 >> 3) & 0x03) !== 0x01 &&
    ((b1 >> 1) & 0x03) !== 0x00 &&
    ((b2 >> 4) & 0x0f) !== 0x00 &&
    ((b2 >> 4) & 0x0f) !== 0x0f &&
    ((b2 >> 2) & 0x03) !== 0x03
  )
}

function downloadToFile(
  request: DownloadRequest,
  filePath: string,
  onProgress: (downloaded: number, total: number) => void,
  isCancelled: () => boolean = () => false,
  registerCancel: (cancel: () => void) => (() => void) = () => () => {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isCancelled()) {
      reject(new CancelledDownloadError())
      return
    }
    const url = new URL(request.url)
    const client = url.protocol === 'https:' ? https : http
    let file: fs.WriteStream | null = null
    let settled = false
    let unregister = () => {}
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      unregister()
      if (error) fs.rm(filePath, { force: true }, () => reject(error))
      else resolve()
    }
    const req = client.request(url, {
      method: request.method || 'GET',
      headers: { ...DEFAULT_HEADERS, ...(request.headers || {}) },
    }, (response) => {
      if ((response.statusCode || 0) >= 400) {
        response.resume()
        finish(new DownloadHttpStatusError(response.statusCode || 0, request.url))
        return
      }
      const total = Number(response.headers['content-length'] || 0)
      let downloaded = 0
      file = fs.createWriteStream(filePath)
      response.on('data', (chunk: Buffer) => {
        if (isCancelled()) {
          req.destroy(new CancelledDownloadError())
          return
        }
        downloaded += chunk.length
        onProgress(downloaded, total)
      })
      response.pipe(file)
      file.on('finish', () => file?.close(() => finish()))
      file.on('error', (error) => finish(error))
    })
    unregister = registerCancel(() => {
      req.destroy(new CancelledDownloadError())
      file?.destroy(new CancelledDownloadError())
      finish(new CancelledDownloadError())
    })
    req.on('error', (error) => finish(error))
    req.setTimeout(60_000, () => {
      req.destroy(new Error('下载超时'))
    })
    req.end()
  })
}

function resolveTaskPublishDate(task: DownloadTask, sourceSong: Song): string {
  const direct = readPublishDate(task.song.raw) || readPublishDate(sourceSong.raw)
  if (direct) return direct
  for (const candidate of normalizeCandidates(task)) {
    const date = readPublishDate(candidate.song.raw)
    if (date) return date
  }
  return ''
}

function buildAttempts(task: DownloadTask): Array<{ platform: Platform; quality: Quality; song: Song }> {
  const candidates = normalizeCandidates(task)
  const seen = new Set<string>()
  const attempts: Array<{ platform: Platform; quality: Quality; song: Song }> = []
  for (const candidate of candidates) {
    for (const quality of qualityFallbacks(task.quality, candidate.song.qualitys)) {
      const key = `${candidate.song.platform}:${candidate.song.platformSongId}:${quality}`
      if (seen.has(key)) continue
      seen.add(key)
      attempts.push({ platform: candidate.song.platform, quality, song: candidate.song })
    }
  }
  return attempts.length ? attempts : [{ platform: task.song.platform, quality: task.quality, song: task.song }]
}

function normalizeCandidates(task: DownloadTask): CandidateSource[] {
  const raw = task.song.raw.downloadCandidates
  const candidates = Array.isArray(raw) ? raw.filter((item): item is CandidateSource => {
    return !!item && typeof item === 'object' && 'song' in item && !!(item as CandidateSource).song
  }) : []
  if (!candidates.some((candidate) => candidate.song.platform === task.song.platform && candidate.song.platformSongId === task.song.platformSongId)) {
    candidates.unshift({ platform: task.song.platform, songId: task.song.platformSongId, qualitys: task.song.qualitys, song: task.song })
  }
  return candidates
}

function qualityFallbacks(preferred: Quality, available: Quality[]): Quality[] {
  const ordered = QUALITY_ORDER.includes(preferred) ? QUALITY_ORDER.slice(QUALITY_ORDER.indexOf(preferred)) : [preferred, ...QUALITY_ORDER]
  const set = new Set(available?.length ? available : ordered)
  return ordered.filter((quality) => set.has(quality))
}

function buildSearchQuery(song: Song, includeAlbum: boolean): string {
  return [song.title, song.artist, includeAlbum ? song.albumName : '']
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
}

function filterSearchFallbackMatches(target: Song, candidates: Song[], requireAlbum: boolean): Song[] {
  return candidates.filter((candidate) => isStrictSearchFallbackMatch(target, candidate, requireAlbum))
}

function mergeSearchFallbackMatches(primary: Song[], secondary: Song[]): Song[] {
  const seen = new Set<string>()
  const result: Song[] = []
  for (const song of [...primary, ...secondary]) {
    const key = `${song.platform}:${song.platformSongId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(song)
  }
  return result
}

function rankSearchFallbackMatches(target: Song, candidates: Song[]): Song[] {
  return [...candidates].sort((left, right) => {
    const leftPlatform = SEARCH_FALLBACK_PLATFORMS.indexOf(left.platform)
    const rightPlatform = SEARCH_FALLBACK_PLATFORMS.indexOf(right.platform)
    const leftAlbum = normalizedText(left.albumName) === normalizedText(target.albumName) ? 0 : 1
    const rightAlbum = normalizedText(right.albumName) === normalizedText(target.albumName) ? 0 : 1
    if (leftAlbum !== rightAlbum) return leftAlbum - rightAlbum
    if (leftPlatform !== rightPlatform) return normalizePriority(leftPlatform) - normalizePriority(rightPlatform)
    return Math.abs((left.duration || 0) - (target.duration || 0)) - Math.abs((right.duration || 0) - (target.duration || 0))
  })
}

function isStrictSearchFallbackMatch(target: Song, candidate: Song, requireAlbum: boolean): boolean {
  if (normalizedTitle(candidate.title) !== normalizedTitle(target.title)) return false
  if (!artistMatches(target.artist, candidate.artist)) return false
  if (target.duration && candidate.duration && Math.abs(target.duration - candidate.duration) > 5) return false
  const sameAlbum = normalizedText(target.albumName) && normalizedText(target.albumName) === normalizedText(candidate.albumName)
  if (requireAlbum && !sameAlbum) return false
  if (!sameAlbum && normalizedText(target.title) !== normalizedText(candidate.title)) return false
  if (!sameAlbum && hasUnexpectedVersionMarker(target.title, candidate.title)) return false
  return true
}

function normalizedTitle(value: string): string {
  return normalizedText(value).replace(/live|伴奏|remix|翻唱|cover|现场版|电音版|民乐版|纯音乐/g, '')
}

function normalizedText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-_.·、，,。；;：:"“”‘'()[\]【】《》<>/\\|]/g, '')
}

function artistMatches(target: string, candidate: string): boolean {
  const targetText = normalizedText(target)
  const candidateText = normalizedText(candidate)
  return !targetText || !candidateText || targetText.includes(candidateText) || candidateText.includes(targetText)
}

function hasUnexpectedVersionMarker(targetTitle: string, candidateTitle: string): boolean {
  const markerRe = /live|伴奏|remix|翻唱|cover|现场版|电音版|民乐版|纯音乐/i
  return markerRe.test(candidateTitle) && !markerRe.test(targetTitle)
}

function normalizePriority(index: number): number {
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${Math.round(value)} B`
}

function formatAttemptError(platform: Platform, songId: string, quality: Quality, error: unknown): string {
  const idText = songId ? ` / ${songId}` : ''
  return `${platformLabel(platform)}${idText} / ${quality}：${formatDownloadError(error)}`
}

function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS[platform] || platform
}

function formatDownloadError(error: unknown): string {
  if (error instanceof DownloadHttpStatusError) {
    if (error.statusCode === 401) return '下载地址未授权（401）'
    if (error.statusCode === 403) return '访问被拒绝（403），正在尝试其他音质或来源'
    if (error.statusCode === 404) return '下载地址不存在（404）'
    if (error.statusCode === 410) return '下载地址已失效（410）'
    if (error.statusCode === 429) return '请求过快（429），请稍后重试'
    if (error.statusCode >= 500) return `音乐服务暂时不可用（${error.statusCode}）`
    return `下载请求失败（HTTP ${error.statusCode}）`
  }

  const message = error instanceof Error ? error.message : String(error || '')
  if (/request is not/i.test(message)) return '音乐源请求接口不兼容：缺少 request 方法'
  if (/timeout|timed out|超时/i.test(message)) return '下载超时'
  if (/下载地址无效|invalid url|未返回.*下载地址|返回.*下载地址.*无效/i.test(message)) return '音乐源未返回可用下载地址'
  return message || '下载失败'
}

export function toLxMusicInfo(song: Song, quality?: Quality): Record<string, unknown> {
  const raw = song.raw || {}
  const songmid = resolveLxSongmid(song)
  const baseHash = resolveBaseHash(song)
  const selectedHash = song.platform === 'kg'
    ? baseHash
    : resolveQualityHash(song, quality) || baseHash
  const qualitys = buildLxQualitys(song)
  const meta: Record<string, unknown> = {
    songId: songmid,
    albumName: song.albumName,
    albumId: readRawString(raw, 'album_id') || readRawString(raw, 'albumId') || song.albumId,
    picUrl: song.coverUrl || '',
    qualitys: song.qualitys.map((type) => ({ type, size: readQualitySize(raw, type), hash: resolveQualityHash(song, type) || selectedHash })),
    _qualitys: qualitys,
  }

  if (song.platform === 'kg') {
    meta.hash = selectedHash
    meta.albumAudioId = readRawValue(raw, 'album_audio_id') || readRawValue(raw, 'albumAudioId')
    meta.audioId = readRawValue(raw, 'audio_id') || readRawValue(raw, 'audioId')
  } else if (song.platform === 'tx') {
    meta.strMediaMid = readNestedRawString(raw, ['file', 'media_mid']) || readRawString(raw, 'strMediaMid') || readRawString(raw, 'media_mid') || readRawString(raw, 'mid') || song.platformSongId
    meta.id = readRawValue(raw, 'song_id') || readRawValue(raw, 'songId') || readRawValue(raw, 'id')
    meta.albumMid = readNestedRawString(raw, ['album', 'mid']) || readRawString(raw, 'albumMid') || readRawString(raw, 'album_mid') || readRawString(raw, 'albummid')
  } else if (song.platform === 'wy' || song.platform === 'kw') {
    meta.songId = songmid
  }

  return {
    id: song.id,
    source: song.platform,
    name: song.title,
    singer: song.artist,
    albumName: song.albumName,
    albumId: song.albumId,
    songmid,
    hash: selectedHash,
    interval: song.duration ? `${Math.floor(song.duration / 60).toString().padStart(2, '0')}:${Math.floor(song.duration % 60).toString().padStart(2, '0')}` : '',
    img: song.coverUrl || '',
    types: song.qualitys.map((type) => ({ type, size: readQualitySize(raw, type), hash: resolveQualityHash(song, type) || selectedHash })),
    _types: qualitys,
    meta,
  }
}

function resolveLxSongmid(song: Song): string {
  const raw = song.raw || {}
  if (song.platform === 'kg') {
    return readRawString(raw, 'audio_id') || readRawString(raw, 'audioId') || readRawString(raw, 'album_audio_id') || song.platformSongId
  }
  if (song.platform === 'tx') {
    return readRawString(raw, 'mid') || readRawString(raw, 'songmid') || readRawString(raw, 'songMid') || song.platformSongId
  }
  if (song.platform === 'kw') {
    return String(readRawString(raw, 'rid') || readRawString(raw, 'DC_TARGETID') || readRawString(raw, 'MUSICRID') || readRawString(raw, 'musicrid') || song.platformSongId).replace(/^MUSIC_/, '')
  }
  if (song.platform === 'wy') {
    return readRawString(raw, 'id') || song.platformSongId
  }
  return song.platformSongId
}

function buildLxQualitys(song: Song): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (const quality of song.qualitys) {
    result[quality] = {
      size: readQualitySize(song.raw, quality),
      hash: resolveQualityHash(song, quality),
    }
  }
  return result
}

function resolveBaseHash(song: Song): string {
  const raw = song.raw || {}
  if (song.platform === 'kg') {
    return readRawString(raw, 'hash') || readRawString(raw, 'FileHash') || song.platformSongId
  }
  return readRawString(raw, 'hash') || song.platformSongId
}

function resolveQualityHash(song: Song, quality?: Quality): string {
  const raw = song.raw || {}
  if (song.platform !== 'kg') return readRawString(raw, 'hash') || song.platformSongId
  if (quality === 'flac24bit') return readRawString(raw, 'hash_high') || readRawString(raw, 'highhash') || readRawString(raw, 'resHash') || readRawString(raw, 'sqhash') || readRawString(raw, 'hash_flac') || readRawString(raw, 'hash') || song.platformSongId
  if (quality === 'flac') return readRawString(raw, 'sqhash') || readRawString(raw, 'hash_flac') || readRawString(raw, 'flachash') || readRawString(raw, 'hash') || song.platformSongId
  if (quality === '320k') return readRawString(raw, '320hash') || readRawString(raw, 'hash_320') || readRawString(raw, 'hqhash') || readRawString(raw, 'hash') || song.platformSongId
  return readRawString(raw, 'hash') || readRawString(raw, 'FileHash') || song.platformSongId
}

function readQualitySize(raw: Record<string, unknown>, quality: Quality): number {
  const keys = quality === 'flac24bit'
    ? ['filesize_high', 'highfilesize', 'resFileSize']
    : quality === 'flac'
      ? ['sqfilesize', 'filesize_flac', 'flacfilesize']
      : quality === '320k'
        ? ['320filesize', 'filesize_320', 'filesize_320mp3']
        : ['filesize', 'm4afilesize']
  for (const key of keys) {
    const value = Number(readRawValue(raw, key) || 0)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function readRawString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  return value == null ? '' : String(value)
}

function readRawValue(raw: Record<string, unknown>, key: string): unknown {
  return raw[key]
}

function readNestedRawString(raw: Record<string, unknown>, pathKeys: string[]): string {
  let current: unknown = raw
  for (const key of pathKeys) {
    if (!current || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[key]
  }
  return current == null ? '' : String(current)
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').toLowerCase()
}
