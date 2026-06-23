import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { LxSourceBridge } from '../src/main/core/sourceBridge'

describe('LX source bridge', () => {
  it('initializes script and calls musicUrl, lyric and pic actions', async () => {
    const script = `
      globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, ({ action }) => {
        if (action === 'musicUrl') return { url: 'https://example.test/song.flac', headers: { Referer: 'https://example.test/' } }
        if (action === 'lyric') return { lyric: '[00:00.00]歌词', tlyric: '[00:00.00]lyric' }
        if (action === 'pic') return 'https://example.test/cover.jpg'
      })
      globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, {
        status: true,
        sources: { kw: { actions: ['musicUrl', 'lyric', 'pic'], qualitys: ['flac'] } }
      })
    `
    const bridge = new LxSourceBridge(script)

    await expect(bridge.initialize()).resolves.toMatchObject({ sources: { kw: expect.any(Object) } })
    await expect(bridge.requestMusicUrl('kw', { name: 'Song' }, 'flac')).resolves.toMatchObject({
      url: 'https://example.test/song.flac',
      headers: { Referer: 'https://example.test/' },
    })
    await expect(bridge.requestLyric('kw', { name: 'Song' })).resolves.toMatchObject({ lyric: '[00:00.00]歌词' })
    await expect(bridge.requestPic('kw', { name: 'Song' })).resolves.toBe('https://example.test/cover.jpg')
  })

  it('provides LX request helper for source scripts', async () => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          ok: req.method === 'POST',
          source: body.source,
          url: 'https://example.test/song.flac',
        }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const script = `
      globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, async ({ action }) => {
        if (action !== 'musicUrl') return null
        const resp = await new Promise((resolve, reject) => {
          globalThis.lx.request('http://127.0.0.1:${port}/music/url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { source: 'wy' },
          }, (err, resp) => err ? reject(err) : resolve(resp))
        })
        if (resp.statusCode !== 200 || resp.body.source !== 'wy') throw new Error('bad request helper response')
        return resp.body.url
      })
      globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, {
        status: true,
        sources: { wy: { actions: ['musicUrl'], qualitys: ['flac'] } }
      })
    `
    const bridge = new LxSourceBridge(script)

    await expect(bridge.requestMusicUrl('wy', { name: 'Song' }, 'flac')).resolves.toMatchObject({
      url: 'https://example.test/song.flac',
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
