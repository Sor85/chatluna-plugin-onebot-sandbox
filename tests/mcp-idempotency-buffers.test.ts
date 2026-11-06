import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxMcpService } from '../src/mcp/service'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 测试控制服务里每个内存缓冲区都必须有上限。
 *
 * `idempotency` 与 `confirmations` 此前既无上限也无过期清理，而同类的事件、调用记录、上传媒体三个
 * 缓冲区都有。幂等缓存每条都持有结果的 `structuredClone`，`apply_environment_changes` 的结果里带
 * 完整场景快照，因此不做破坏性操作的长跑会话会让它无界增长。
 *
 * 时间用测试运行器的假时钟推进，不注入时钟。
 */

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-29T09:00:00.000Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  await stopMcpTestApps()
})

async function createSpace(service: SandboxMcpService, token: string, key: string) {
  return await service.callTool(token, 'create_test_space', { name: '幂等空间', idempotencyKey: key }) as { spaceId: string }
}

describe('MCP 幂等缓存的上限与有效期', () => {
  it('有效期内同键同参数重放仍返回首次结果', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)

    const first = await createSpace(service, credential.token, 'window-replay')
    vi.advanceTimersByTime(29 * 60_000)
    const replayed = await createSpace(service, credential.token, 'window-replay')

    expect(replayed.spaceId).toBe(first.spaceId)
    expect((await service.callTool(credential.token, 'list_test_spaces', {}) as { items: unknown[] }).items).toHaveLength(1)
  })

  it('同键不同参数仍返回 idempotency_conflict', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)

    await createSpace(service, credential.token, 'conflict-key')
    await expect(service.callTool(credential.token, 'create_test_space', {
      name: '另一个名字',
      idempotencyKey: 'conflict-key',
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('超出有效期后同键重放重新执行操作', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)

    const first = await createSpace(service, credential.token, 'expiring-key')
    vi.advanceTimersByTime(30 * 60_000 + 1)
    const replayed = await createSpace(service, credential.token, 'expiring-key')

    // 超出窗口的重放不返回首次结果，而是真的再执行一次。
    expect(replayed.spaceId).not.toBe(first.spaceId)
    expect((await service.callTool(credential.token, 'list_test_spaces', {}) as { items: unknown[] }).items).toHaveLength(2)
  })

  it('超出条数上限后最旧的幂等记录被淘汰，上限与有效期由服务选项覆盖', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true, { idempotencyLimit: 2 })

    const oldest = await createSpace(service, credential.token, 'evict-1')
    await createSpace(service, credential.token, 'evict-2')
    const newest = await createSpace(service, credential.token, 'evict-3')

    // 最旧的一条被淘汰后重放会重新建空间；上限内的条目仍返回首次结果。
    expect((await createSpace(service, credential.token, 'evict-1')).spaceId).not.toBe(oldest.spaceId)
    expect((await createSpace(service, credential.token, 'evict-3')).spaceId).toBe(newest.spaceId)
  })

  it('携带 idempotencyKey 的工具在参数描述里写明实际生效的有效期与条数上限', () => {
    const readWindows = (harness: ReturnType<typeof createMcpTestService>) => harness.service.getCapabilityCatalog().tools
      .map(({ name, inputSchema }) => ({ name, properties: (inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {} }))
      .filter(({ properties }) => 'idempotencyKey' in properties)
      .map(({ name, properties }) => ({ name, description: properties.idempotencyKey!.description ?? '' }))

    const defaults = readWindows(createMcpTestService(['read']))
    expect(defaults.map(({ name }) => name)).toContain('send_message')
    for (const { name, description } of defaults) {
      // 有效期是对外承诺，消费者只能从 inputSchema 学到它。
      expect({ name, statesWindow: description.includes('30 分钟') && description.includes('500 条') }).toEqual({ name, statesWindow: true })
    }

    // 数值可覆盖，声明必须跟着变：写死默认值会让非默认部署发布一份错误的契约。
    const overridden = readWindows(createMcpTestService(['read'], false, { idempotencyLimit: 7, idempotencyTtlMs: 120_000 }))
    for (const { name, description } of overridden) {
      expect({ name, statesWindow: description.includes('2 分钟') && description.includes('7 条') }).toEqual({ name, statesWindow: true })
    }
  })

  it('工具指南资源里的幂等描述与工具清单一致', () => {
    const { service, credential } = createMcpTestService(['read'], false, { idempotencyLimit: 9, idempotencyTtlMs: 90_000 })

    const guide = service.readResource(credential.token, 'onebot-sandbox://guide') as {
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, { description?: string }> } }>
    }
    const sendMessage = guide.tools.find(({ name }) => name === 'send_message')
    expect(sendMessage?.inputSchema.properties?.idempotencyKey?.description).toContain('9 条')
  })
})

describe('MCP 确认令牌不再堆积', () => {
  /** 确认令牌的留存量没有对外观察面，因此直接断言缓冲区本身——它就是本用例的断言对象。 */
  const retained = (service: SandboxMcpService) => (service as unknown as { confirmations: Map<string, unknown> }).confirmations.size

  it('签发新令牌时清掉已过期的令牌', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'manage'])
    const prepare = async (id: string) => await service.callTool(credential.token, 'prepare_destructive_action', {
      expectedRevision: control.getSnapshot().revision,
      tool: 'delete_environment_entity',
      arguments: { kind: 'user', id },
    })

    await prepare('10001')
    await prepare('10002')
    expect(retained(service)).toBe(2)

    // 令牌本来就 60 秒过期，此前只有被使用时才会删除，签发后不用的令牌永久留存。
    vi.advanceTimersByTime(61_000)
    await prepare('10003')
    expect(retained(service)).toBe(1)
  })

  it('有效期内的令牌不会被清理掉', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'manage'])
    const revision = control.getSnapshot().revision
    const first = await service.callTool(credential.token, 'prepare_destructive_action', {
      expectedRevision: revision,
      tool: 'delete_environment_entity',
      arguments: { kind: 'user', id: '10001' },
    }) as { confirmationToken: string }

    vi.advanceTimersByTime(30_000)
    await service.callTool(credential.token, 'prepare_destructive_action', {
      expectedRevision: revision,
      tool: 'delete_environment_entity',
      arguments: { kind: 'user', id: '10002' },
    })
    expect(retained(service)).toBe(2)

    await expect(service.callTool(credential.token, 'delete_environment_entity', {
      kind: 'user',
      id: '10001',
      confirmationToken: first.confirmationToken,
    })).resolves.toMatchObject({ revision: expect.any(Number) })
  })
})
