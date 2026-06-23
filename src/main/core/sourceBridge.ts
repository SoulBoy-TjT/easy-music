import http from 'node:http'
import https from 'node:https'
import vm from 'node:vm'
import type { DownloadRequest, Lyrics, Platform, Quality } from './types'

interface InitInfo {
  status: boolean
  name?: string
  sources?: Record<string, unknown>
  description?: string
  version?: string
  author?: string
}

type SourceHandler = (request: { action: string; source?: Platform; info?: Record<string, unknown> }) => unknown | Promise<unknown>
type LxRequestCallback = (error: Error | null, response?: Record<string, unknown> | null, body?: unknown) => void

interface LxRequestOptions {
  method?: string
  timeout?: number
  headers?: Record<string, unknown>
  body?: unknown
}

export class LxSourceBridge {
  private initialized = false
  private initInfo: InitInfo | null = null
  private handler: SourceHandler | null = null

  constructor(private readonly script: string) {}

  async initialize(): Promise<InitInfo> {
    if (this.initInfo) return this.initInfo
    const context: Record<string, unknown> = {
      console,
      setTimeout,
      clearTimeout,
      Buffer,
      globalThis: undefined,
    }
    context.globalThis = context
    const bridge = this
    context.lx = {
      EVENT_NAMES: {
        request: 'request',
        inited: 'inited',
        updateAlert: 'updateAlert',
      },
      request: lxRequest,
      on(eventName: string, handler: SourceHandler) {
        if (eventName === 'request') bridge.handler = handler
        return Promise.resolve()
      },
      send(eventName: string, data: InitInfo) {
        if (eventName === 'inited') {
          bridge.initialized = true
          bridge.initInfo = data
        }
        return Promise.resolve()
      },
      env: 'desktop',
      version: 'easy-music-local',
      utils: {
        buffer: {
          from: (...args: Parameters<typeof Buffer.from>) => Buffer.from(...args),
        },
        crypto: {},
      },
    }
    vm.runInNewContext(this.script, context, { timeout: 5000 })
    const info = this.initInfo as InitInfo | null
    if (!this.initialized || !info?.status) throw new Error('音乐源初始化失败')
    return info
  }

  async requestMusicUrl(source: Platform, musicInfo: Record<string, unknown>, quality: Quality, refresh = false): Promise<DownloadRequest> {
    const result = await this.request('musicUrl', source, { type: quality, musicInfo, refresh })
    return normalizeDownloadRequest(result)
  }

  async requestLyric(source: Platform, musicInfo: Record<string, unknown>): Promise<Lyrics | null> {
    const result = await this.request('lyric', source, { musicInfo })
    return result && typeof result === 'object' ? result as Lyrics : null
  }

  async requestPic(source: Platform, musicInfo: Record<string, unknown>): Promise<string | null> {
    const result = await this.request('pic', source, { musicInfo })
    return typeof result === 'string' ? result : null
  }

  private async request(action: string, source: Platform, info: Record<string, unknown>): Promise<unknown> {
    await this.initialize()
    if (!this.handler) throw new Error('音乐源未注册请求处理器')
    return this.handler({ action, source, info })
  }
}

function lxRequest(url: string, options: LxRequestOptions = {}, callback?: LxRequestCallback): () => void {
  const cb = typeof callback === 'function' ? callback : () => {}
  let endpoint: URL
  try {
    endpoint = new URL(url)
  } catch (error) {
    cb(error instanceof Error ? error : new Error(String(error)), null, null)
    return () => {}
  }

  const method = String(options.method || 'GET').toUpperCase()
  const headers = normalizeHeaders(options.headers)
  const payload = buildRequestPayload(options.body, headers)
  const client = endpoint.protocol === 'https:' ? https : http
  const req = client.request(endpoint, { method, headers }, (response) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => chunks.push(chunk))
    response.on('end', () => {
      const raw = Buffer.concat(chunks)
      const body = parseResponseBody(raw)
      cb(null, {
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        raw,
        body,
      }, body)
    })
  })
  req.on('error', (error) => cb(error, null, null))
  const timeout = Number(options.timeout || 60_000)
  req.setTimeout(Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 60_000) : 60_000, () => {
    req.destroy(new Error('请求超时'))
  })
  if (payload != null) req.write(payload)
  req.end()
  return () => req.destroy()
}

function normalizeHeaders(headers: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]))
}

function buildRequestPayload(body: unknown, headers: Record<string, string>): string | Buffer | null {
  if (body == null) return null
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type') && !(typeof body === 'string' || Buffer.isBuffer(body))) {
    headers['Content-Type'] = 'application/json'
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) {
    headers['Content-Length'] = String(Buffer.byteLength(payload))
  }
  return payload
}

function parseResponseBody(raw: Buffer): unknown {
  const text = raw.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function normalizeDownloadRequest(value: unknown): DownloadRequest {
  if (typeof value === 'string') return validateDownloadRequest({ url: value })
  if (value && typeof value === 'object') return validateDownloadRequest(value as DownloadRequest)
  throw new Error('音乐源返回的下载地址无效')
}

function validateDownloadRequest(request: DownloadRequest): DownloadRequest {
  const url = String(request.url || '').trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('音乐源返回的下载地址无效')
  return {
    url,
    method: String(request.method || 'GET').toUpperCase(),
    headers: Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [key, String(value)])),
  }
}
