import { App } from './helpers/app'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { HTTP_API_ERROR_STATUS, HTTP_API_VERSION, describeHttpApiCapabilities, isHttpApiPath, normalizeBasePath, parseHttpApiArguments, resolveHttpApiRoute } from '../src/mcp/http-api'
import { SandboxTestEndpointServer } from '../src/mcp/server'
import { STABLE_ERROR_CODES, SandboxMcpService, type SandboxMcpQuotaConfig } from '../src/mcp/service'
import type { SandboxMcpScope } from '../src/mcp/types'
import { SandboxTestSpaceService } from '../src/test-spaces'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

/** 起一个同时承载两种协议表述的真实监听器，并返回访问它所需的地址与凭证。 */
async function startEndpoint(
  scopes: SandboxMcpScope[],
  options: {
    mcpEnabled?: boolean
    httpEnabled?: boolean
    httpPath?: string
    allowedOrigins?: string[]
    quota?: Partial<SandboxMcpQuotaConfig>
  } = {},
) {
  const app = new App()
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-http-api-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
  const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
  const service = new SandboxMcpService(app, control, { dataDirectory: directory, testSpaces, ...options.quota })
  const credential = service.createCredential('HTTP 测试凭证', scopes)
  const httpPath = options.httpPath ?? '/api'
  const server = new SandboxTestEndpointServer(app, service, {
    host: '127.0.0.1',
    port: 0,
    allowedSources: ['127.0.0.0/8', '::1/128'],
    allowedOrigins: options.allowedOrigins ?? [],
    mcp: { enabled: options.mcpEnabled ?? true, path: '/mcp' },
    http: { enabled: options.httpEnabled ?? true, path: httpPath },
  })
  await server.start()
  cleanups.push(async () => { await server.stop(); await app.stop() })
  const address = server.getAddress()
  if (!address) throw new Error('测试控制端点监听地址不存在')
  const origin = `http://127.0.0.1:${address.port}`
  const call = (path: string, init: RequestInit = {}) => fetch(`${origin}${httpPath}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json', ...init.headers },
  })
  return { app, control, service, testSpaces, credential, origin, call }
}

describe('HTTP 测试接口路由', () => {
  it('路径前缀归一化后判定归属，前缀本身与其子路径都算命中', () => {
    expect(normalizeBasePath('/api/')).toBe('/api')
    expect(normalizeBasePath('api')).toBe('/api')
    expect(normalizeBasePath('  ')).toBe('/')
    expect(isHttpApiPath('/api', '/api')).toBe(true)
    expect(isHttpApiPath('/api/v1/tools', '/api')).toBe(true)
    // 前缀必须按路径段结束，否则 `/apiary` 这类同前缀路径会被误收。
    expect(isHttpApiPath('/apiary/v1/tools', '/api')).toBe(false)
    expect(isHttpApiPath('/mcp', '/api')).toBe(false)
  })

  it('把路径解析成四条路由，并按路由钉住 HTTP 动词', () => {
    const route = (method: string, pathname: string, query = '') => resolveHttpApiRoute(
      { method, pathname, searchParams: new URLSearchParams(query), body: '' },
      '/api',
    )

    expect(route('GET', '/api/v1/tools')).toEqual({ kind: 'list-tools' })
    expect(route('POST', '/api/v1/tools/send_message')).toEqual({ kind: 'call-tool', tool: 'send_message' })
    expect(route('GET', '/api/v1/resources')).toEqual({ kind: 'list-resources' })
    expect(route('GET', '/api/v1/resources', 'uri=onebot-sandbox://guide'))
      .toEqual({ kind: 'read-resource', uri: 'onebot-sandbox://guide' })

    expect(() => route('POST', '/api/v1/tools')).toThrow('只接受 GET')
    expect(() => route('GET', '/api/v1/tools/send_message')).toThrow('只接受 POST')
    // 版本段缺失或写错都是路径不存在，而不是「工具不存在」：破坏性变更走新版本段。
    expect(() => route('GET', '/api/tools')).toThrow('路径不存在')
    expect(() => route('GET', '/api/v2/tools')).toThrow('路径不存在')
    expect(() => route('GET', '/api/v1/unknown')).toThrow('路径不存在')
  })

  it('空请求体等价于无参调用，顶层非对象被当场拒绝', () => {
    expect(parseHttpApiArguments('')).toEqual({})
    expect(parseHttpApiArguments('   ')).toEqual({})
    expect(parseHttpApiArguments('{"spaceId":"space-1"}')).toEqual({ spaceId: 'space-1' })
    expect(() => parseHttpApiArguments('{')).toThrow('不是合法 JSON')
    expect(() => parseHttpApiArguments('[1,2]')).toThrow('顶层必须是 JSON 对象')
    expect(() => parseHttpApiArguments('"text"')).toThrow('顶层必须是 JSON 对象')
  })

  /**
   * 状态码表与错误码清单双向一致。
   *
   * 「不缺」由类型系统保证（表声明为 `Record<SandboxMcpStableErrorCode, number>`），编译器管不到的
   * 是「不多」：删掉一个在用的错误码后，表里那条会静默留下。两侧独立书写，因此不构成实现等于自己。
   */
  it('每个稳定错误码都有显式的 HTTP 状态码，且表里没有已删除的码', () => {
    expect(Object.keys(HTTP_API_ERROR_STATUS).sort()).toEqual([...STABLE_ERROR_CODES].sort())
    for (const [code, status] of Object.entries(HTTP_API_ERROR_STATUS)) {
      expect(status, code).toBeGreaterThanOrEqual(400)
      expect(status, code).toBeLessThan(600)
    }
  })
})

describe('HTTP 测试接口自述', () => {
  const endpoint = { enabled: true, path: '/api', host: '127.0.0.1', port: 61901, tls: false }
  /** 自述里的占位符换成真实值，才能拿去过解析器。 */
  const fill = (target: string) => target
    .replace('<工具名>', 'send_message')
    .replace('<资源 URI>', 'onebot-sandbox://guide')

  /**
   * 自述与解析器双向钉住。
   *
   * 这条不是「实现等于自己」：自述给出的是请求目标字符串，解析器吃的是拆开的 pathname 与查询参数，
   * 两侧各自书写。真正被证明的是「控制台上照抄的那一行请求，端点真的认」——路由改了却忘记改自述，
   * 或自述里的动词写反，都会在这里变红，而不是等到有人照着页面发请求发现 404 或 405。
   */
  it('自述的每条路由都能被解析器按声明的动词与目标解析回同一种路由', () => {
    const catalog = describeHttpApiCapabilities(endpoint)

    expect(catalog.routes.map(({ kind }) => kind)).toEqual(['list-tools', 'call-tool', 'list-resources', 'read-resource'])
    for (const route of catalog.routes) {
      const [pathname, query = ''] = fill(route.target).split('?')
      const resolved = resolveHttpApiRoute(
        { method: route.method, pathname: pathname!, searchParams: new URLSearchParams(query), body: '' },
        endpoint.path,
      )
      expect(resolved.kind, route.target).toBe(route.kind)
      expect(route.summary.trim(), route.target).not.toBe('')
    }
  })

  it('路由前缀跟随端点路径与版本段，请求体上限与状态码映射直接取本模块的常量', () => {
    const catalog = describeHttpApiCapabilities({ ...endpoint, path: 'test-api/' })

    expect(catalog.basePath).toBe('/test-api')
    expect(catalog.version).toBe(HTTP_API_VERSION)
    expect(catalog.routes.map(({ target }) => target)).toEqual([
      '/test-api/v1/tools',
      '/test-api/v1/tools/<工具名>',
      '/test-api/v1/resources',
      '/test-api/v1/resources?uri=<资源 URI>',
    ])
    expect(catalog.maxBodyBytes).toBe(32 * 1024 * 1024)
    expect(catalog.errorStatuses.map(({ code }) => code)).toEqual([...STABLE_ERROR_CODES])
    expect(catalog.errorStatuses.find(({ code }) => code === 'rate_limited')?.status).toBe(429)
  })

  /** 通配监听地址不是目的地：原样写进基址会给出一个看着像地址、却未必连得上的示例。 */
  it('基址按 TLS 选协议，并把通配监听地址换成回环地址', () => {
    expect(describeHttpApiCapabilities(endpoint).baseUrl).toBe('http://127.0.0.1:61901')
    expect(describeHttpApiCapabilities({ ...endpoint, tls: true }).baseUrl).toBe('https://127.0.0.1:61901')
    expect(describeHttpApiCapabilities({ ...endpoint, host: '0.0.0.0' }).baseUrl).toBe('http://127.0.0.1:61901')
    expect(describeHttpApiCapabilities({ ...endpoint, host: '' }).baseUrl).toBe('http://127.0.0.1:61901')
    // IPv6 字面量必须加方括号，否则冒号会被当成端口分隔符。
    expect(describeHttpApiCapabilities({ ...endpoint, host: '::' }).baseUrl).toBe('http://[::1]:61901')
    expect(describeHttpApiCapabilities({ ...endpoint, host: 'fd00::1' }).baseUrl).toBe('http://[fd00::1]:61901')
  })

  it('总开关关闭时照样自述，只把 enabled 报成 false', () => {
    const catalog = describeHttpApiCapabilities({ ...endpoint, enabled: false })

    expect(catalog.enabled).toBe(false)
    expect(catalog.routes).toHaveLength(4)
  })
})

describe('HTTP 测试接口端到端', () => {
  it('按凭证权限发现工具与资源，请求体直接就是工具参数', async () => {
    const { call } = await startEndpoint(['read', 'interact', 'manage', 'debug'])

    const tools = await call('/v1/tools')
    expect(tools.status).toBe(200)
    const catalogue = await tools.json() as {
      testApiVersion: number
      tools: Array<{ name: string; scope: string; inputSchema: unknown; outputSchema?: unknown }>
    }
    expect(catalogue.testApiVersion).toBe(1)
    expect(catalogue.tools.map(({ name }) => name)).toContain('get_server_info')
    // inputSchema 必须随清单一起给出：脚本除此之外没有别的地方能学到参数契约。
    expect(catalogue.tools.find(({ name }) => name === 'send_message')?.inputSchema).toBeTruthy()
    // 返回声明同理，且两种表述读的是同一份 service.listTools，因此这里守的是「下一次改动只顾 MCP
    // 那一侧」不会静默让 HTTP 表述少一份声明。
    expect(catalogue.tools.find(({ name }) => name === 'wait_for_message')?.outputSchema)
      .toMatchObject({ type: 'object', required: ['outcome', 'cursor'] })
    expect(catalogue.tools.find(({ name }) => name === 'get_scene_snapshot')).not.toHaveProperty('outputSchema')

    // 无参工具不带请求体也能调；不必为了凑 JSON-RPC 的仪式感写 -d '{}'。
    const info = await call('/v1/tools/get_server_info', { method: 'POST' })
    expect(info.status).toBe(200)
    expect(await info.json()).toMatchObject({ name: 'onebot-sandbox', testApiVersion: 1, transport: 'http' })

    const resources = await call('/v1/resources')
    expect((await resources.json() as { resources: Array<{ uri: string }> }).resources.map(({ uri }) => uri))
      .toContain('onebot-sandbox://guide')

    const guide = await call(`/v1/resources?uri=${encodeURIComponent('onebot-sandbox://guide')}`)
    expect(guide.status).toBe(200)
    expect(await guide.json()).toMatchObject({ testApiVersion: 1 })
  })

  it('曾经返回裸数组的三个工具在两种表述下都是同一份带 items 的对象', async () => {
    const { call, credential, origin } = await startEndpoint(['read'])
    const client = new Client({ name: 'chatluna-sandbox-representation-test', version: '1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${credential.token}` } },
    }))

    try {
      for (const tool of ['list_test_spaces', 'list_pending_requests', 'get_capability_matrix']) {
        const http = await (await call(`/v1/tools/${tool}`, { method: 'POST' })).json()
        expect(http, tool).toEqual({ items: expect.any(Array) })

        const mcp = await client.callTool({ name: tool, arguments: {} }) as {
          structuredContent?: Record<string, unknown>
          content: Array<{ text: string }>
        }
        // MCP 协议要求 structuredContent 必须是对象：这三个工具返回裸数组时只有 content[0].text，
        // 消费者对它们必须改走「解析文本」的路径，而对其余三十八个工具可以直接读结构化内容。
        expect(mcp.structuredContent, tool).toEqual(http)
        expect(JSON.parse(mcp.content[0]!.text), tool).toEqual(http)
      }
    } finally {
      await client.close()
    }
  })

  it('分页结果在两种表述下逐字段一致，游标跨表述可用', async () => {
    const { call, service, credential } = await startEndpoint(['read', 'debug'])
    // 三次读取各留一条测试调用记录，够翻两页。
    for (let index = 0; index < 3; index += 1) await call('/v1/tools/get_server_info', { method: 'POST' })

    const args = { tool: 'get_server_info', limit: 2 }
    const httpPage = await (await call('/v1/tools/list_test_call_records', { method: 'POST', body: JSON.stringify(args) })).json() as {
      items: Array<{ id: string }>
      nextPageCursor: string
    }
    expect(httpPage.items).toHaveLength(2)
    expect(httpPage.nextPageCursor).toEqual(expect.any(String))

    // 同一次分页经服务层直调（MCP 表述那条路径）拿到的是同一份对象：这三票都不允许出现
    // 「一种表述有、另一种没有」的字段。
    const mcpPage = await service.callTool(credential.token, 'list_test_call_records', args, { transport: 'mcp' })
    expect(mcpPage).toEqual(httpPage)

    // 一种表述给出的游标在另一种表述下照样能续页：游标属于工具而不属于表述。
    const nextViaMcp = await service.callTool(credential.token, 'list_test_call_records', {
      ...args, pageCursor: httpPage.nextPageCursor,
    }, { transport: 'mcp' }) as { items: Array<{ id: string }> }
    expect(nextViaMcp.items.map(({ id }) => id)).not.toEqual(httpPage.items.map(({ id }) => id))
  })

  it('工具错误映射成真实状态码，信封字段与 MCP 表述逐字一致', async () => {
    const { call } = await startEndpoint(['read'])

    const missing = await call('/v1/tools/not_a_tool', { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'tool_not_found', retryable: false, revision: expect.any(Number) })

    // 只有 read 权限的凭证调 manage 工具：403 而不是 200 + 正文里的 isError。
    const forbidden = await call('/v1/tools/create_test_space', { method: 'POST', body: JSON.stringify({ idempotencyKey: 'k-1' }) })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ code: 'permission_denied' })

    const invalid = await call('/v1/tools/get_conversation', { method: 'POST', body: JSON.stringify({ operatorId: '10001', conversationId: '  ' }) })
    expect(invalid.status).toBe(400)
    // 失败也写测试调用记录，traceId 就是那条记录的 ID，可据此调 get_test_call_record 复盘。
    expect(await invalid.json()).toMatchObject({ code: 'invalid_arguments', traceId: expect.any(String) })

    const brokenJson = await call('/v1/tools/get_server_info', { method: 'POST', body: '{' })
    expect(brokenJson.status).toBe(400)
    expect(await brokenJson.json()).toMatchObject({ code: 'invalid_arguments', message: '请求体不是合法 JSON' })
  })

  it('限流返回 429 并带上 Retry-After 秒数', async () => {
    const { call } = await startEndpoint(['read'], { quota: { readPerMinute: 1 } })

    expect((await call('/v1/tools/get_server_info', { method: 'POST' })).status).toBe(200)
    const limited = await call('/v1/tools/get_server_info', { method: 'POST' })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await limited.json()).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: expect.any(Number) })
  })

  /**
   * 额度按凭证记账而不是按协议表述记账，因此换一种表述绕不开限流。这条是安全相关的不变量：
   * 若两种表述各自记账，任何被限流的调用方只要改走另一条路径就能把额度翻倍。
   */
  it('两种协议表述共用同一份凭证额度', async () => {
    const { call, service, credential } = await startEndpoint(['read'], { quota: { readPerMinute: 1 } })

    expect((await call('/v1/tools/get_server_info', { method: 'POST' })).status).toBe(200)
    await expect(service.callTool(credential.token, 'get_server_info', {}, { transport: 'mcp' }))
      .rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('门禁拒绝也用同一份信封形状，脚本只需要一条解析路径', async () => {
    const { origin } = await startEndpoint(['read'], { allowedOrigins: ['https://allowed.example'] })

    const unauthorized = await fetch(`${origin}/api/v1/tools`)
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({ code: 'unauthorized', retryable: false, recovery: expect.any(String) })

    const forbiddenOrigin = await fetch(`${origin}/api/v1/tools`, { headers: { origin: 'https://forbidden.example' } })
    expect(forbiddenOrigin.status).toBe(403)
    expect(await forbiddenOrigin.json()).toMatchObject({ code: 'permission_denied' })
  })

  it('动词与未知路径按 HTTP 语义拒绝', async () => {
    const { call, origin } = await startEndpoint(['read'])

    const wrongMethod = await call('/v1/tools', { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(await wrongMethod.json()).toMatchObject({ code: 'method_not_allowed' })

    const unknownRoute = await call('/v1/nope')
    expect(unknownRoute.status).toBe(404)
    expect(await unknownRoute.json()).toMatchObject({ code: 'resource_not_found' })

    // 两个前缀都没命中时无从得知调用方想用哪种表述，因此保留简短形态。
    const offPrefix = await fetch(`${origin}/nowhere`, { headers: { authorization: 'Bearer x' } })
    expect(offPrefix.status).toBe(404)
    expect(await offPrefix.json()).toEqual({ error: 'not_found' })
  })

  it('两种表述各自可单独启用，未启用的路径不响应', async () => {
    const httpOnly = await startEndpoint(['read'], { mcpEnabled: false })
    const mcpProbe = await fetch(`${httpOnly.origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${httpOnly.credential.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    // 只启用 HTTP 表述时监听器照样起得来，MCP 路径退化成未注册路径。
    expect(mcpProbe.status).toBe(404)
    expect((await httpOnly.call('/v1/tools')).status).toBe(200)

    const mcpOnly = await startEndpoint(['read'], { httpEnabled: false })
    expect((await mcpOnly.call('/v1/tools')).status).toBe(404)
    expect(await (await mcpOnly.call('/v1/tools')).json()).toEqual({ error: 'not_found' })
  })

  it('两种表述都不启用时不占端口', async () => {
    const app = new App()
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-http-api-off-'))
    const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media') })
    const service = new SandboxMcpService(app, control, { dataDirectory: directory })
    const server = new SandboxTestEndpointServer(app, service, {
      host: '127.0.0.1', port: 0, allowedSources: [], allowedOrigins: [],
      mcp: { enabled: false, path: '/mcp' }, http: { enabled: false, path: '/api' },
    })
    cleanups.push(() => app.stop())

    await server.start()
    expect(server.getAddress()).toBeUndefined()
  })
})

describe('测试调用记录的协议表述标注', () => {
  it('HTTP 与 MCP 两种来路共用同一批记录，并可按来路筛选', async () => {
    const { call, service, credential } = await startEndpoint(['read', 'debug'])

    await call('/v1/tools/get_server_info', { method: 'POST' })
    // 同一个凭证走服务层直调，等价于 MCP 表述那条路径的记录形态。
    await service.callTool(credential.token, 'get_server_info', {}, { transport: 'mcp' })

    const all = service.listCallRecords({ tool: 'get_server_info', order: 'asc' })
    expect(all.records.map(({ transport }) => transport)).toEqual(['http', 'mcp'])
    expect(service.listCallRecords({ transport: 'http' }).records.every(({ transport }) => transport === 'http')).toBe(true)
    expect(service.listCallRecords({ transport: 'mcp' }).records.map(({ transport }) => transport)).toEqual(['mcp'])

    // 同一份筛选维度也从工具侧可用，外部测试控制器不必只能靠 Console 面板区分来路。
    const listed = await call('/v1/tools/list_test_call_records', { method: 'POST', body: JSON.stringify({ transport: 'http', tool: 'get_server_info' }) })
    expect((await listed.json() as { items: Array<{ transport: string }> }).items.every(({ transport }) => transport === 'http')).toBe(true)
  })

  it('记录里带上真实来源 IP，与凭证名一起构成复盘线索', async () => {
    const { call, service } = await startEndpoint(['read', 'debug'])

    await call('/v1/tools/get_server_info', { method: 'POST' })

    const [record] = service.listCallRecords({ transport: 'http' }).records
    expect(record).toMatchObject({ credentialName: 'HTTP 测试凭证', sourceIp: '127.0.0.1', transport: 'http' })
  })
})
