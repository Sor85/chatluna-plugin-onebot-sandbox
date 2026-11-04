import { errorDetail } from '../error-detail'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from 'cordis'
import { SandboxMcpError } from './types'
import { SandboxMcpService } from './service'
import { HTTP_API_MAX_BODY_BYTES, handleHttpApiRequest, isHttpApiPath, toHttpApiErrorResponse } from './http-api'

/** 一种协议表述在端点上的启用开关与路径。两种表述共用同一个监听器与同一套门禁。 */
export interface SandboxTestEndpointProtocolConfig {
  enabled: boolean
  path: string
}

// 只描述传输：监听地址、端口、TLS、来源与 Origin 白名单，以及两种协议表述各自的开关与路径。
// 测试凭证的频率与并发配额由测试控制服务（SandboxMcpQuotaConfig）执行，不在此声明。
//
// 传输字段是共享的而不是每种表述各来一份：非回环缺 TLS 时的明文告警（ADR-0082）一旦分成两份
// 配置，就有了两次配错的机会，而两种表述面对的风险完全相同。
export interface SandboxTestEndpointServerConfig {
  host: string
  port: number
  allowedSources: string[]
  allowedOrigins: string[]
  tlsCertPath?: string
  tlsKeyPath?: string
  mcp: SandboxTestEndpointProtocolConfig
  http: SandboxTestEndpointProtocolConfig
}

/**
 * 传输层门禁的三类拒绝。
 *
 * MCP 分支沿用既有的 `{ error: <键> }` 简短形态；HTTP 分支把同一次拒绝转成与工具错误逐字同形的
 * 信封，让脚本只需要一条解析路径。状态码在 HTTP 分支由错误码推导，不在此重复声明。
 */
const TRANSPORT_REJECTIONS = {
  source_forbidden: {
    status: 403,
    toError: () => new SandboxMcpError('permission_denied', '来源 IP 不在允许列表中', false, '请把调用方 IP 加入允许的来源列表，或改从允许的来源发起调用。'),
  },
  origin_forbidden: {
    status: 403,
    toError: () => new SandboxMcpError('permission_denied', 'Origin 不在允许列表中', false, '请把该 Origin 加入允许列表，或去掉请求中的 Origin 头。'),
  },
  unauthorized: {
    status: 401,
    toError: () => new SandboxMcpError('unauthorized', '缺少或无效的 Bearer 测试凭证', false, '请在 Authorization 头中携带有效的测试凭证 Token。'),
  },
} as const

type TransportRejection = keyof typeof TRANSPORT_REJECTIONS

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function normalizeAddress(address?: string): string {
  if (!address) return ''
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0
}

function sourceMatches(address: string, rule: string): boolean {
  const [network, prefixText] = rule.split('/')
  if (!prefixText) return address === network
  const family = isIP(network)
  if (!family || isIP(address) !== family) return false
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return false
  if (family === 6) {
    const blockList = new BlockList()
    blockList.addSubnet(network, prefix, 'ipv6')
    return blockList.check(address, 'ipv6')
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(network) & mask)
}

function jsonContent(value: unknown) {
  // MCP 协议要求 structuredContent 必须是 object；数组或原始值会被 SDK 以 -32602 拒绝，因此仅对
  // 普通对象附带。工具结果今天全部是对象（返回裸数组的三个已经包了一层），这条判定因此不再挑掉
  // 任何工具；它留着是因为判定本身对协议的理解是对的，而不是因为还有工具要走 else 分支。
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(structured ? { structuredContent: structured } : {}) }
}

/**
 * 测试控制端点的独立 HTTP 监听器。
 *
 * 同一个监听器上并列承载两种协议表述：MCP Streamable HTTP 与 HTTP 测试接口，按路径分流。两者
 * 共用监听地址、TLS、来源与 Origin 白名单、凭证校验，以及背后同一个测试控制服务。
 */
export class SandboxTestEndpointServer {
  private server?: HttpServer

  constructor(private ctx: Context, private service: SandboxMcpService, private config: SandboxTestEndpointServerConfig) {}

  async start(): Promise<void> {
    if ((!this.config.mcp.enabled && !this.config.http.enabled) || this.server) return
    // 非回环缺 TLS 时照常启动，只持续告警（ADR-0082）：这里没有可用的替代传输，拒绝启动只会让
    // 局域网调试无路可走，而是否接受明文只有部署者知道。
    if (!isLoopback(this.config.host) && (!this.config.tlsCertPath || !this.config.tlsKeyPath)) {
      this.ctx.logger('onebot-sandbox').warn('测试控制端点正在非回环地址上使用明文 HTTP；Bearer Token 可能被窃取。')
    }
    const listener = (request: IncomingMessage, response: ServerResponse) => void this.handleRequest(request, response)
    this.server = this.config.tlsCertPath && this.config.tlsKeyPath
      ? createHttpsServer({ cert: readFileSync(this.config.tlsCertPath), key: readFileSync(this.config.tlsKeyPath) }, listener)
      : createServer(listener)
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  getAddress(): { address: string; port: number } | undefined {
    const address = this.server?.address()
    return address && typeof address !== 'string' ? { address: address.address, port: address.port } : undefined
  }

  // 整个请求处理都在 try 内：listener 用 `void this.handleRequest(...)` 调用，任何逃出这里的异常
  // 都会变成 unhandled rejection，同时那个 HTTP 请求永远收不到响应，一直挂到客户端超时——一个
  // 坏凭证条目就能让端点对所有客户端表现为挂起。因此路径判定、来源校验、凭证校验、MCP 服务器与
  // transport 的构造全部纳入 try，transport 与 mcp 在 finally 里按需关闭。
  private async handleRequest(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
    let transport: StreamableHTTPServerTransport | undefined
    let mcp: Server | undefined
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const protocol = this.resolveProtocol(url.pathname)
      // 两个前缀都没命中时无从得知调用方想用哪种表述，因此保留简短形态而不是猜一种信封。
      if (!protocol) return this.writeJson(response, 404, { error: 'not_found' })
      if (protocol === 'mcp' && request.method !== 'POST') return this.writeJson(response, 405, { error: 'method_not_allowed' })

      const sourceIp = normalizeAddress(request.socket.remoteAddress)
      const screened = this.screen(request, sourceIp)
      if (typeof screened !== 'string') {
        const { status, toError } = TRANSPORT_REJECTIONS[screened.rejection]
        if (protocol === 'http') {
          const rejected = toHttpApiErrorResponse(this.service, toError())
          return this.writeJson(response, rejected.status, rejected.body, rejected.headers)
        }
        return this.writeJson(response, status, { error: screened.rejection })
      }
      const token = screened

      if (protocol === 'http') return await this.handleHttpApi(request, response, url, token, sourceIp)

      mcp = this.createMcpServer(token, sourceIp)
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await mcp.connect(transport)
      // 不再等待响应写入完成：SDK 1.29.0 的 handleRequest 把请求整体委托给
      // @hono/node-server 的 getRequestListener 并 await 它，返回时响应已经写完。
      // 旧版会提前返回，那时必须额外等待 finish/close，否则客户端只能收到无正文的 200。
      await transport.handleRequest(request, response)
    } catch (error) {
      this.ctx.logger('onebot-sandbox').error('%s\n%s', '测试控制端点请求处理失败', errorDetail(error))
      if (!response.headersSent) this.writeJson(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
      // 响应头已经发出时无法再改状态码，但必须收尾：不结束响应等于让请求挂到客户端超时。
      else if (!response.writableEnded) response.end()
    } finally {
      if (transport) await transport.close().catch(() => undefined)
      if (mcp) await mcp.close().catch(() => undefined)
    }
  }

  /**
   * 按路径判断本次请求该交给哪种协议表述。
   *
   * MCP 走精确匹配、HTTP 走前缀匹配，因此两者即使配成同一个路径也不会互相吞掉：路径本身是 MCP，
   * 它下面的 `/v1/...` 子路径是 HTTP 测试接口。未启用的表述一律不参与匹配。
   */
  private resolveProtocol(pathname: string): 'mcp' | 'http' | undefined {
    if (this.config.mcp.enabled && pathname === this.config.mcp.path) return 'mcp'
    if (this.config.http.enabled && isHttpApiPath(pathname, this.config.http.path)) return 'http'
  }

  /** 门禁：通过时返回凭证明文 Token，否则返回拒绝类别。两种表述共用这一份判定。 */
  private screen(request: IncomingMessage, sourceIp: string): string | { rejection: TransportRejection } {
    if (this.config.allowedSources.length && !this.config.allowedSources.some((rule) => sourceMatches(sourceIp, rule))) {
      return { rejection: 'source_forbidden' }
    }
    const origin = request.headers.origin
    if (origin && !this.config.allowedOrigins.includes(origin)) return { rejection: 'origin_forbidden' }
    const authorization = request.headers.authorization ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!this.service.authenticate(token)) return { rejection: 'unauthorized' }
    return token
  }

  private async handleHttpApi(request: IncomingMessage, response: ServerResponse, url: URL, token: string, sourceIp: string) {
    // handleHttpApiRequest 自身不抛，这个 try 覆盖的是它之前的请求体读取——超限会抛
    // payload_too_large，必须同样落成信封，否则会被外层 catch 写成 JSON-RPC 形状的 500。
    try {
      const body = request.method === 'POST' ? await this.readBody(request) : ''
      const result = await handleHttpApiRequest(this.service, token, {
        method: request.method ?? 'GET',
        pathname: url.pathname,
        searchParams: url.searchParams,
        body,
      }, { basePath: this.config.http.path, sourceIp })
      return this.writeJson(response, result.status, result.body, result.headers)
    } catch (error) {
      const result = toHttpApiErrorResponse(this.service, error)
      return this.writeJson(response, result.status, result.body, result.headers)
    }
  }

  /**
   * 读取请求体，边读边计字节数。
   *
   * 必须在累计过程中判上限而不是读完再看长度：读完再看等于先把超大请求体整份收进内存，上限也就
   * 没有保护作用了。抛出会让 for-await 销毁请求流，连接随之中断，这正是超限时期望的行为。
   */
  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += buffer.byteLength
      if (size > HTTP_API_MAX_BODY_BYTES) {
        throw new SandboxMcpError('payload_too_large', `请求体超过 ${HTTP_API_MAX_BODY_BYTES} 字节上限`, false, '请减小请求体，或改用 upload_media 分次上传媒体。')
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  // 使用低层 Server 而非 McpServer.registerTool：后者要求 zod schema 才能生成
  // tools/list 的 inputSchema（通配 record 会序列化为空 properties，客户端将无从
  // 得知参数契约）。参数校验本就在工具执行体内部完成，这里只需把工具注册表条目
  // 携带的 JSON Schema 原样暴露。
  private createMcpServer(token: string, sourceIp: string): Server {
    const server = new Server({ name: 'chatluna-plugin-onebot-sandbox', version: '0.0.1' }, { capabilities: { tools: {}, resources: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      // outputSchema 只在条目声明了它时映射出去：给未覆盖的工具补一个空对象等于向客户端承诺一份
      // 它兑现不了的 structuredContent 契约。
      tools: this.service.listTools(token).map(({ name, description, inputSchema, outputSchema }) => ({
        name,
        description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return jsonContent(await this.service.callTool(token, request.params.name, request.params.arguments ?? {}, { sourceIp, transport: 'mcp' }))
      } catch (error) {
        // 工具错误的归一化发生在 service.callTool 里：它把领域拒绝与未预期异常都收敛成
        // SandboxMcpError 再抛出，因此这里几乎总是走 instanceof 分支。else 分支留着不是冗余——
        // jsonContent 的 JSON.stringify 也在本 try 内，序列化失败会抛非 SandboxMcpError 的异常。
        const normalized = error instanceof SandboxMcpError ? error : new SandboxMcpError('internal_error', '工具结果序列化失败')
        if (!(error instanceof SandboxMcpError)) this.ctx.logger('onebot-sandbox').error('%s\n%s', `MCP 工具 ${request.params.name} 的结果无法序列化。`, errorDetail(error))
        // traceId 用失败调用写下的测试调用记录 ID，消费者可据此调 get_test_call_record 取回该次失败；
        // revision 同样由 callTool 回填成失败真正发生的那个空间的版本。凭证校验阶段抛出的错误既没有
        // 记录可指，也没有空间可指，只能退回随机标识与主场景版本。
        return { ...jsonContent({ code: normalized.code, message: normalized.message, retryable: normalized.retryable, recovery: normalized.recovery, details: normalized.details, retryAfterMs: normalized.retryAfterMs, revision: normalized.revision ?? this.service.getRevision(), traceId: normalized.traceId ?? randomUUID() }), isError: true }
      }
    })
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: this.service.listResources(token).map(({ uri, name, mimeType }) => ({ uri, name, mimeType })),
    }))
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(this.service.readResource(token, request.params.uri)) }],
    }))
    return server
  }

  private writeJson(response: import('node:http').ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
    response.end(JSON.stringify(body))
  }
}

export { isLoopback, sourceMatches }
