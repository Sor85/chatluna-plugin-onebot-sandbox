import { h } from '@satorijs/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './helpers/app'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxMediaStorage } from '../src/media-storage'
import { DEFAULT_MEDIA_MAX_SIZE, MEBIBYTE, mediaRequestBodyLimit } from '../src/media-limits'
import { readMediaResponse } from '../src/media-download'
import { SandboxMcpService } from '../src/mcp/service'
import { SandboxTestEndpointServer } from '../src/mcp/server'
import { describeHttpApiCapabilities } from '../src/mcp/http-api'
import { SandboxTestSpaceService } from '../src/test-spaces'
import type { SandboxWorkspaceState } from '../src/types'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'sandbox-media-limits-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

function mediaInput(size: number) {
  return { fileName: 'fixture.zip', mimeType: 'application/zip', dataBase64: Buffer.alloc(size, 0x41).toString('base64') }
}

async function createHost(mediaMaxSize: number) {
  const app = new App()
  app.baseDir = await directory()
  cleanups.push(() => app.stop())
  await app.ready()
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { runtimeBots, mediaMaxSize })
  const spaces = new SandboxTestSpaceService(app, runtimeBots, undefined, undefined, { mediaMaxSize })
  await app.start()
  return { app, control, spaces }
}

describe('可配置单文件大小上限', () => {
  it('默认仍为 10 MiB，上调后接受完整边界并拒绝多出的一个字节', async () => {
    const path = await directory()
    expect(new SandboxMediaStorage(path).maxSize).toBe(DEFAULT_MEDIA_MAX_SIZE)
    const storage = new SandboxMediaStorage(path, undefined, 12 * MEBIBYTE)
    expect(storage.save(mediaInput(12 * MEBIBYTE)).size).toBe(12 * MEBIBYTE)
    expect(() => storage.save(mediaInput(12 * MEBIBYTE + 1))).toThrow('媒体大小不能超过 12 MiB')
  })

  it('下调只限制新媒体，不阻止读取已经保存的大文件', async () => {
    const path = await directory()
    const saved = new SandboxMediaStorage(path, undefined, 2 * MEBIBYTE).save(mediaInput(2 * MEBIBYTE))
    const smaller = new SandboxMediaStorage(path, undefined, MEBIBYTE)
    expect(Buffer.from(smaller.read(saved).dataBase64, 'base64')).toHaveLength(2 * MEBIBYTE)
    expect(() => smaller.save(mediaInput(MEBIBYTE + 1))).toThrow('媒体大小不能超过 1 MiB')
  })

  it('主环境、测试空间与工作区下发使用同一字节上限', async () => {
    const { control, spaces } = await createHost(12 * MEBIBYTE)
    const space = spaces.createSpace({ name: '媒体限额空间' })
    expect(control.mediaMaxSize).toBe(12 * MEBIBYTE)
    expect(space.control.mediaMaxSize).toBe(12 * MEBIBYTE)
    expect(space.control.storeMedia(mediaInput(11 * MEBIBYTE)).size).toBe(11 * MEBIBYTE)
    const callbacks = new Map<string, (...args: any[]) => any>()
    const registrar: SandboxConsoleRegistrar = {
      addEntry() {}, broadcast() {},
      addListener(name, callback) { callbacks.set(name, callback) },
    }
    registerConsole(registrar, control, {
      sandboxAccentColor: '#2563eb', sandboxTimBubbleTail: true,
      sandboxIncomingBubbleStyle: 'shadow', sandboxMarkRecalledMessages: true,
    }, undefined, spaces)
    for (const input of [{}, { spaceId: space.id }]) {
      const workspace: SandboxWorkspaceState = await callbacks.get('onebot-sandbox.workspace')!(input)
      expect(workspace.mediaMaxSize).toBe(12 * MEBIBYTE)
    }
  })

  it('机器人远程附件与远程头像不再被旧 10 MiB 常量拦截', async () => {
    const { control } = await createHost(12 * MEBIBYTE)
    const bytes = Buffer.alloc(11 * MEBIBYTE, 0x41)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/zip' } }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetcher)
    await control.bot.sendMessage('30001', h.file('https://example.test/fixture.zip'))
    expect(control.getSnapshot().messages.at(-1)?.media?.[0].size).toBe(bytes.length)
    const avatar = await control.importAvatar('user', '10001', 'https://example.test/avatar.png')
    expect(avatar).toMatch(/^sandbox-media:\/\//)
  })
})

describe('远程媒体按流执行限额', () => {
  it('声明超限时取消正文，不读取整个文件', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '101' } })
    await expect(readMediaResponse(response, 100)).rejects.toThrow('媒体大小不能超过')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([undefined, '1'])('缺失或不可信 Content-Length（%s）不能绕过累计检查', async (length) => {
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(60)); controller.enqueue(new Uint8Array(41)) },
      cancel,
    })
    const response = new Response(body, { headers: length ? { 'content-length': length } : {} })
    await expect(readMediaResponse(response, 100, '头像')).rejects.toThrow('头像大小不能超过')
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('HTTP 与 MCP 上传预算', () => {
  it('预算容纳 Base64 膨胀与 JSON 开销，HTTP 能力自述同步更新', () => {
    expect(mediaRequestBodyLimit(DEFAULT_MEDIA_MAX_SIZE)).toBe(32 * MEBIBYTE)
    const limit = 50 * MEBIBYTE
    const expected = 4 * Math.ceil(limit / 3) + MEBIBYTE
    expect(mediaRequestBodyLimit(limit)).toBe(expected)
    expect(describeHttpApiCapabilities({ enabled: true, path: '/api', host: '127.0.0.1', port: 1, tls: false, mediaMaxSize: limit }).maxBodyBytes).toBe(expected)
  })

  it.each(['http', 'mcp'])('%s 上传可超过旧传输限额，文件边界仍由配置强制执行', async (protocol) => {
    const limit = 25 * MEBIBYTE
    const { app, control, spaces } = await createHost(limit)
    const space = spaces.createSpace({ name: '上传空间' })
    const service = new SandboxMcpService(app, control, { dataDirectory: join(app.baseDir, 'endpoint'), testSpaces: spaces })
    const credential = service.createCredential('大小验证', ['read', 'interact', 'manage'])
    const server = new SandboxTestEndpointServer(app, service, {
      host: '127.0.0.1', port: 0, allowedSources: [], allowedOrigins: [],
      http: { enabled: true, path: '/api' }, mcp: { enabled: true, path: '/mcp' },
    })
    await server.start()
    cleanups.push(() => server.stop())
    const origin = `http://127.0.0.1:${server.getAddress()!.port}`
    const args = { spaceId: space.id, ...mediaInput(limit) }
    if (protocol === 'http') {
      const upload = (input: object) => fetch(`${origin}/api/v1/tools/upload_media`, {
        method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
      })
      const response = await upload(args)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ media: { size: limit } })
      const rejected = await upload({ ...args, ...mediaInput(limit + 1) })
      expect(rejected.status).toBe(422)
      expect(await rejected.json()).toMatchObject({ code: 'domain_error', message: '媒体大小不能超过 25 MiB' })
    } else {
      const client = new Client({ name: 'media-limit-test', version: '1' })
      cleanups.push(() => client.close())
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${credential.token}` } },
      }))
      const result = await client.callTool({ name: 'upload_media', arguments: args })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ media: { size: limit } })
      expect(await client.callTool({ name: 'upload_media', arguments: { ...args, ...mediaInput(limit + 1) } })).toMatchObject({ isError: true })
    }
  }, 20_000)
})
