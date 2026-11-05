import { App } from './helpers/app'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSupportedJsonSchema } from '@chatluna/schema'
import { toolSpec, type ToolDefinition } from '@chatluna/tool'
import type { Context } from 'cordis'
import { Config } from '../src'
import { SANDBOX_BOT_TOOL_PREFIX, formatToolError, registerSandboxBotTools, toSupportedJsonSchema, toToolDefinition } from '../src/chatluna/tools'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxMcpService } from '../src/mcp/service'
import { SANDBOX_MCP_TOOL_DECLARATIONS } from '../src/mcp/tool-registry'
import { SandboxMcpError, type SandboxMcpScope } from '../src/mcp/types'
import { SandboxTestSpaceService } from '../src/test-spaces'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function createService() {
  const app = new App()
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-bot-tools-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
  const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
  const service = new SandboxMcpService(app, control, { dataDirectory: directory, testSpaces })
  cleanups.push(async () => { await app.stop() })
  return { service }
}

/** 只实现注册路径用到的两处：`inject` 立即回调，`tools.define` 收集定义。 */
function createToolHost() {
  const defined: ToolDefinition<unknown>[] = []
  const injected: string[][] = []
  const inner = { tools: { define: (definition: ToolDefinition<unknown>) => { defined.push(definition); return () => {} } }, logger: () => ({ info() {} }) }
  const host = { inject: (deps: string[], callback: (ctx: unknown) => void) => { injected.push(deps); callback(inner) } }
  return { ctx: host as unknown as Context, defined, injected }
}

describe('机器人工具配置', () => {
  it('默认关闭，开启后默认只给读取与交互权限', () => {
    expect(Config({}).botTools).toEqual({ enabled: false, scopes: ['read', 'interact'] })
  })

  it('关闭时不碰工具服务', () => {
    const { service } = createService()
    const { ctx, injected } = createToolHost()
    registerSandboxBotTools(ctx, service, { enabled: false, scopes: ['read'] })
    expect(injected).toEqual([])
  })
})

describe('工具声明投影', () => {
  it('每个工具的参数 schema 都能被 v2 转换，名字符合 v2 工具名规则', () => {
    for (const declaration of SANDBOX_MCP_TOOL_DECLARATIONS) {
      const schema = toSupportedJsonSchema(declaration.inputSchema)
      expect(() => assertSupportedJsonSchema(schema), declaration.name).not.toThrow()
      expect(`${SANDBOX_BOT_TOOL_PREFIX}${declaration.name}`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    }
  })

  it('去掉的取值范围写进说明', () => {
    const schema = toSupportedJsonSchema({
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 100, description: '每页条数' }, ids: { type: 'array', items: { type: 'string' }, maxItems: 5 } },
      anyOf: [{ required: ['limit'] }],
    }) as { anyOf?: unknown; properties: Record<string, { description?: string; maximum?: unknown }> }
    expect(schema.anyOf).toBeUndefined()
    expect(schema.properties.limit).toEqual({ type: 'number', description: '每页条数；取值 1~100' })
    expect(schema.properties.ids.description).toBe('最多 5 项')
  })

  it('只注册权限范围内的工具，读取类标为只读，等待类放宽同步上限', () => {
    const { service } = createService()
    const { ctx, defined, injected } = createToolHost()
    registerSandboxBotTools(ctx, service, { enabled: true, scopes: ['read', 'interact'] })

    expect(injected).toEqual([['tools']])
    const expected = SANDBOX_MCP_TOOL_DECLARATIONS.filter(({ scope }) => scope === 'read' || scope === 'interact')
    expect(defined.map(({ name }) => name)).toEqual(expected.map(({ name }) => `${SANDBOX_BOT_TOOL_PREFIX}${name}`))
    const byName = new Map(defined.map((definition) => [definition.name, definition]))
    expect(byName.get('sandbox_get_scene_snapshot')?.traits?.effect).toBe('read')
    expect(byName.get('sandbox_send_message')?.traits?.effect).toBe('write')
    expect(byName.get('sandbox_send_message')?.describe?.()).toContain(byName.get('sandbox_send_message')?.description?.split(' ')[0])
    expect(byName.get('sandbox_wait_for_message')?.traits?.timeout).toBeGreaterThan(120_000)
    expect(byName.get('sandbox_get_scene_snapshot')?.traits?.timeout).toBeUndefined()
    // `ctx.tools.define` 注册时把参数 schema 转回 JSON Schema，转不了会直接抛错。
    for (const definition of defined) expect(() => toolSpec(definition), definition.name).not.toThrow()
  })
})

describe('进程内调用方', () => {
  it('调用经同一套治理，测试调用记录标为 chatluna 来路', async () => {
    const { service } = createService()
    const caller = service.createInternalCaller({ id: 'bot', name: 'ChatLuna 机器人', scopes: ['read'], transport: 'chatluna' })

    expect(await caller.callTool('get_server_info', {})).toMatchObject({ name: 'onebot-sandbox', transport: 'chatluna' })
    const [record] = service.listCallRecords({ transport: 'chatluna' }).records
    expect(record).toMatchObject({ tool: 'get_server_info', credentialName: 'ChatLuna 机器人', transport: 'chatluna', status: 'success' })
    // 内部凭证不进凭证列表，网络端点也认不出它。
    expect(service.listCredentials()).toEqual([])
  })

  it('权限范围之外的工具被拒绝，错误正文带错误码与记录 ID', async () => {
    const { service } = createService()
    const scopes: SandboxMcpScope[] = ['read']
    const caller = service.createInternalCaller({ id: 'bot', name: 'ChatLuna 机器人', scopes, transport: 'chatluna' })
    expect(caller.listTools().every(({ scope }) => scope === 'read')).toBe(true)

    const error = await caller.callTool('send_message', {}).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(SandboxMcpError)
    const text = formatToolError(error)
    expect(text).toMatch(/^\[permission_denied\] /)
    expect(text).toContain(`traceId: ${(error as SandboxMcpError).traceId}`)
  })

  it('工具执行失败时抛出格式化后的错误，没有返回值时答 null', async () => {
    const declaration = SANDBOX_MCP_TOOL_DECLARATIONS.find(({ name }) => name === 'get_server_info')!
    const failing = toToolDefinition(declaration, () => declaration, async () => {
      throw new SandboxMcpError('invalid_arguments', '参数不对', false, '请改参数。')
    })
    await expect(failing.run!({}, {} as never)).rejects.toThrow('[invalid_arguments] 参数不对\n请改参数。')
    const empty = toToolDefinition(declaration, () => declaration, async () => undefined)
    expect(await empty.run!({}, {} as never)).toBeNull()
  })
})
