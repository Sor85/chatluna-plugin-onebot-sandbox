import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, captureLogs } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { SandboxTestEndpointServer } from '../src/mcp/server'
import { SandboxMcpService } from '../src/mcp/service'
import type { SandboxTestCredential } from '../src/mcp/types'

/**
 * 凭证存储的健壮性。
 *
 * 一个长度不合规的 `tokenDigest` 曾经让 `timingSafeEqual` 抛 `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`，
 * 而抛出点在传输层 `try` 之外且 `handleRequest` 是 `void` 调用，结果是 unhandled rejection 加请求
 * 挂死——一个坏条目让整个端点对所有客户端表现为挂起。非原子写入配合「读取失败静默清空」则是一次
 * 崩溃静默丢光全部凭证，现场没有任何线索。
 */

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const CREDENTIAL_FILE = 'test-credentials.json'

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 写一份凭证文件，返回它所在的数据目录。 */
function seedCredentialFile(entries: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-credential-'))
  writeFileSync(join(directory, CREDENTIAL_FILE), `${JSON.stringify(entries, null, 2)}\n`)
  return directory
}

function createService(directory: string, app = new App()) {
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media') })
  cleanups.push(() => app.stop())
  return { app, control, service: new SandboxMcpService(app, control, { dataDirectory: directory }) }
}

/** 捕获服务所在上下文的日志输出，同时让用例不往测试输出里打真实告警。 */
function captureLogger<T>(action: (app: App) => T): { result: T; printed: string } {
  const app = new App()
  const capture = captureLogs(app)
  try {
    return { result: action(app), printed: capture.printed.join('\n') }
  } finally {
    capture.restore()
  }
}

const goodToken = 'a'.repeat(43)
const goodCredential = {
  id: 'good-credential',
  name: '合规凭证',
  scopes: ['read'],
  enabled: true,
  tokenDigest: digestToken(goodToken),
  createdAt: '2026-08-29T09:00:00.000Z',
}

describe('测试凭证存储的健壮性', () => {
  it('丢弃长度不合规的 tokenDigest 条目，同文件里的合规凭证仍能认证', () => {
    const directory = seedCredentialFile([
      { ...goodCredential, id: 'short-digest', name: '坏摘要凭证', tokenDigest: 'deadbeef' },
      { ...goodCredential, id: 'non-hex-digest', name: '非十六进制凭证', tokenDigest: 'z'.repeat(64) },
      goodCredential,
    ])
    const { service } = createService(directory)

    expect(service.listCredentials().map(({ id }) => id)).toEqual(['good-credential'])
    // 认证不再抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH，无论传什么 Token。
    expect(() => service.authenticate('任意 Token')).not.toThrow()
    expect(service.authenticate(goodToken)?.id).toBe('good-credential')
  })

  it('即使坏摘要绕过存储校验进到内存，认证也只是不匹配而不抛异常', () => {
    const { service } = createService(mkdtempSync(join(tmpdir(), 'chatluna-sandbox-credential-')))
    // 三层防护缺一层都留着同类风险：这里绕过 normalizeStoredCredential 直接注入，
    // 断言 authenticate 自己也会先比长度。断言对象就是那份内存凭证列表。
    ;(service as unknown as { credentials: SandboxTestCredential[] }).credentials.push({
      ...goodCredential,
      id: 'in-memory-bad-digest',
      tokenDigest: 'deadbeef',
    } as SandboxTestCredential)

    expect(() => service.authenticate(goodToken)).not.toThrow()
    expect(service.authenticate(goodToken)).toBeUndefined()
  })

  it('凭证文件解析失败时写入告警日志，并回到无有效凭证', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-credential-'))
    writeFileSync(join(directory, CREDENTIAL_FILE), '{ 这不是 JSON')

    const { result, printed } = captureLogger((app) => createService(directory, app))

    // 「解析失败回到无有效凭证」是既有行为，本票只让它可诊断：可选的 MCP 能力不能阻断 WebQQ。
    expect(result.service.listCredentials()).toEqual([])
    expect(printed).toContain(join(directory, CREDENTIAL_FILE))
    expect(printed).toMatch(/凭证/)
  })

  it('凭证写入是原子的，权限保持 0o600', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-credential-'))
    const { app, control, service } = createService(directory)
    service.createCredential('原子写入凭证', ['read'])

    const file = join(directory, CREDENTIAL_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // 直接覆盖原文件时写到一半崩溃就是坏文件，因此写入必须走「临时文件 + rename」。
    // 预放一个上次崩溃留下的临时文件：走 rename 的实现会覆盖并搬走它，直接覆盖的实现会把它留下。
    writeFileSync(`${file}.tmp`, '崩溃残留')
    service.createCredential('第二个凭证', ['read'])
    expect(readdirSync(directory).filter((entry) => entry.startsWith(CREDENTIAL_FILE))).toEqual([CREDENTIAL_FILE])
    expect(statSync(file).mode & 0o777).toBe(0o600)

    // 落盘内容仍是完整可解析的凭证列表，重载后两条都在。
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2)
    const reloaded = new SandboxMcpService(app, control, { dataDirectory: directory })
    expect(reloaded.listCredentials().map(({ name }) => name)).toEqual(['原子写入凭证', '第二个凭证'])
  })

  it('明文 Token 不出现在日志里', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-credential-'))
    const { service } = createService(directory)
    const created = service.createCredential('日志凭证', ['read'])

    // 让文件不可读，逼出加载失败路径，再确认告警里没有明文 Token。
    const file = join(directory, CREDENTIAL_FILE)
    chmodSync(file, 0o000)
    const { printed } = captureLogger((app) => createService(directory, app))
    chmodSync(file, 0o600)

    expect(existsSync(file)).toBe(true)
    expect(printed).not.toContain(created.token)
  })

  it('坏凭证文件不会让 HTTP 端点挂死，请求得到明确响应', async () => {
    const directory = seedCredentialFile([
      { ...goodCredential, id: 'short-digest', name: '坏摘要凭证', tokenDigest: 'deadbeef' },
    ])
    const { app, service } = createService(directory)
    const server = new SandboxTestEndpointServer(app, service, {
      host: '127.0.0.1', port: 0, allowedSources: ['127.0.0.0/8'], allowedOrigins: [],
      mcp: { enabled: true, path: '/mcp' }, http: { enabled: false, path: '/api' },
    })
    await server.start()
    cleanups.push(() => server.stop())
    const address = server.getAddress()
    if (!address) throw new Error('MCP 监听地址不存在')

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${goodToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }),
    })

    // 修复前这里既收不到响应也拿不到状态码：异常在 try 之外抛出，请求一直挂到客户端超时。
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, data: { code: 'unauthorized', retryable: false, recovery: expect.any(String) } },
    })
  })
})
