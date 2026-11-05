import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { App, captureLogs } from './helpers/app'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxTestEndpointServer, sourceMatches } from '../src/mcp/server'
import { SandboxMcpService } from '../src/mcp/service'
import type { SandboxMcpScope } from '../src/mcp/types'
import { SandboxTestSpaceService } from '../src/test-spaces'
import { MCP_RESOURCE_URIS, MCP_TOOL_NAMES } from './helpers/mcp-tool-catalogue'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

/** 起一个真实监听的 MCP 传输层，并返回访问它所需的地址与凭证。 */
async function startHttpServer(
  name: string,
  scopes: SandboxMcpScope[],
  options: { allowedOrigins?: string[]; withTestSpaces?: boolean } = {},
) {
  const app = new App()
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-http-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
  const testSpaces = options.withTestSpaces ? new SandboxTestSpaceService(app, runtimeBots) : undefined
  const service = new SandboxMcpService(app, control, { dataDirectory: directory, testSpaces })
  const credential = service.createCredential(name, scopes)
  const server = new SandboxTestEndpointServer(app, service, {
    host: '127.0.0.1',
    port: 0,
    allowedSources: ['127.0.0.0/8', '::1/128'],
    allowedOrigins: options.allowedOrigins ?? [],
    mcp: { enabled: true, path: '/mcp' },
    http: { enabled: false, path: '/api' },
  })
  await server.start()
  cleanups.push(async () => { await server.stop(); await app.stop() })
  const address = server.getAddress()
  if (!address) throw new Error('MCP 监听地址不存在')
  return { app, control, service, testSpaces, credential, url: new URL(`http://127.0.0.1:${address.port}/mcp`) }
}

/** 用真实 MCP 客户端连上传输层；返回的客户端由调用方负责关闭。 */
async function connectClient(url: URL, token: string, origin?: string) {
  const client = new Client({ name: 'chatluna-sandbox-test', version: '1.0' })
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } },
  }))
  return client
}

describe('MCP Streamable HTTP', () => {
  it('按凭证权限发现完整工具清单并拒绝不受信 Origin', async () => {
    const { credential, url } = await startHttpServer('端到端凭证', ['read', 'interact', 'manage', 'debug'], {
      allowedOrigins: ['https://allowed.example'],
    })

    const forbidden = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.token}`, origin: 'https://forbidden.example', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    })
    expect(forbidden.status).toBe(403)
    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    })
    expect(unauthorized.status).toBe(401)

    const client = await connectClient(url, credential.token, 'https://allowed.example')
    // tools/list 不携带能力范围，因此在传输层按名字与顺序整体比对完整清单；能力范围由服务层断言覆盖。
    const tools = (await client.listTools()).tools
    expect(tools.map(({ name }) => name)).toEqual(MCP_TOOL_NAMES)
    // 返回声明也必须随清单一起带出去：消费者从 tools/list 就该知道等待类工具返回什么，而不必先试调
    // 一次。清单本身由 tests/mcp-tool-output-contract.test.ts 逐条守卫，这里守住传输层没有把它丢掉。
    expect(tools.find(({ name }) => name === 'wait_for_message')?.outputSchema)
      .toMatchObject({ type: 'object', properties: expect.objectContaining({ outcome: expect.anything() }) })
    expect(tools.find(({ name }) => name === 'get_scene_snapshot')).not.toHaveProperty('outputSchema')
    expect((await client.listResources()).resources.map(({ uri }) => uri)).toEqual(MCP_RESOURCE_URIS)
    // 资源不存在按 MCP 规范答 -32002，而不是 SDK 默认的 -32603 内部错误。
    await expect(client.readResource({ uri: 'onebot-sandbox://nope' })).rejects.toMatchObject({ code: -32002 })
    await client.close()
  })

  it('非 POST 请求与传输层拒绝都答 JSON-RPC 错误信封', async () => {
    const { credential, url } = await startHttpServer('信封凭证', ['read'])
    const get = await fetch(url, { headers: { authorization: `Bearer ${credential.token}` } })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect(await get.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000, data: { code: 'method_not_allowed' } } })
    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, data: { code: 'unauthorized', retryable: false, recovery: expect.any(String), revision: expect.any(Number) } },
    })
  })

  it('超出能力范围的工具调用在传输层返回结构化错误信封', async () => {
    // read 让客户端能自己读场景版本与调用记录；manage 缺失使 create_test_space 在
    // callTool 的能力范围检查处被拒，从而走到传输层的错误信封分支。
    const { credential, url } = await startHttpServer('只读凭证', ['read', 'debug'])
    const client = await connectClient(url, credential.token)

    const callTool = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
      content: Array<{ type: string; text: string }>
    }
    const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>

    const snapshot = payload(await callTool('get_scene_snapshot', {})) as { revision: number }
    const result = await callTool('create_test_space', { idempotencyKey: 'envelope-1' })
    expect(result.isError).toBe(true)
    const envelope = payload(result)
    expect(envelope).toMatchObject({
      code: 'permission_denied',
      message: '凭证缺少 manage 权限',
      retryable: false,
      recovery: expect.any(String),
      // 不带 spaceId 的调用失败在主场景，信封版本因此是主场景版本。
      revision: snapshot.revision,
      traceId: expect.any(String),
    })
    // 重试等待时间属于凭证配额那条工作的判据，本用例只验证信封结构，不构造限流场景。
    expect(envelope).not.toHaveProperty('retryAfterMs')
    expect(result.structuredContent).toMatchObject({ code: 'permission_denied', traceId: envelope.traceId })

    // 追踪标识必须真的能把这次失败对应到沙盒侧记录，而不只是一个形状正确的字符串。
    expect(payload(await callTool('get_test_call_record', { recordId: envelope.traceId }))).toMatchObject({
      id: envelope.traceId,
      tool: 'create_test_space',
      status: 'error',
      errorCode: 'permission_denied',
    })
    await client.close()
  })

  it('测试空间里失败的工具调用信封携带该空间的场景版本', async () => {
    const { credential, url } = await startHttpServer('空间凭证', ['read', 'manage'], { withTestSpaces: true })
    const client = await connectClient(url, credential.token)
    const callTool = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as {
      isError?: boolean
      content: Array<{ type: string; text: string }>
    }
    const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>

    const space = payload(await callTool('create_test_space', { name: '信封空间', idempotencyKey: 'envelope-space-1' })) as { spaceId: string; revision: number }
    const applied = payload(await callTool('apply_environment_changes', {
      spaceId: space.spaceId,
      expectedRevision: space.revision,
      idempotencyKey: 'envelope-space-setup-1',
      changes: [{ action: 'create-user', data: { id: '11001', name: '空间用户' } }],
    })) as { revision: number }
    // 主场景一直没被改过，两个版本因此必然不同：信封读错场景就会报主场景的值。
    const main = payload(await callTool('get_scene_snapshot', {})) as { revision: number }
    expect(main.revision).not.toBe(applied.revision)

    const failed = await callTool('apply_environment_changes', {
      spaceId: space.spaceId,
      expectedRevision: applied.revision + 100,
      idempotencyKey: 'envelope-space-conflict-1',
      changes: [],
    })
    expect(failed.isError).toBe(true)
    expect(payload(failed)).toMatchObject({ code: 'revision_conflict', revision: applied.revision })
    await client.close()
  })

  it('同时匹配 IPv4 与 IPv6 CIDR', () => {
    expect(sourceMatches('127.0.0.1', '127.0.0.0/8')).toBe(true)
    expect(sourceMatches('::1', '::1/128')).toBe(true)
    expect(sourceMatches('10.0.0.1', '127.0.0.0/8')).toBe(false)
  })

  it('用真实 SDK 处理 initialize 时响应正文与 Content-Type 完整', async () => {
    // 曾有一层 waitForResponseCompletion 兜住「SDK 在响应写入前提前结束 handleRequest」的旧行为。
    // SDK 1.29.0 把请求整体委托给 @hono/node-server 并 await 它，返回时响应已写完，该兜底已删除；
    // 这条用例守住它描述的症状不再出现：无正文、无 Content-Type 的 200。
    const { credential, url } = await startHttpServer('初始化凭证', ['read'])

    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'initialize-test', version: '1' } } }),
    })

    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ result: { serverInfo: { name: 'chatluna-plugin-onebot-sandbox' } } })
  })

  it('非回环监听缺少 TLS 时照常启动，并持续告警明文传输', async () => {
    const app = new App()
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-tls-'))
    const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media') })
    const service = new SandboxMcpService(app, control, { dataDirectory: directory })
    const server = new SandboxTestEndpointServer(app, service, {
      host: '0.0.0.0', port: 0, allowedSources: [], allowedOrigins: [],
      mcp: { enabled: true, path: '/mcp' }, http: { enabled: false, path: '/api' },
    })
    cleanups.push(async () => { await server.stop(); await app.stop() })

    // 告警必须真的打出来：这是明文传输唯一的可见提示（ADR-0082），端点本身不再拦。
    const { printed, restore } = captureLogs(app)
    try {
      await server.start()
    } finally {
      restore()
    }

    expect(server.getAddress()).toBeDefined()
    expect(printed.join('\n')).toContain('明文 HTTP')
  })
})
