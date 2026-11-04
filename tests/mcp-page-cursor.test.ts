import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxModelRequestStore } from '../src/model-request'
import { SandboxModelRequestCursorExpiredError, SandboxOneBotDebugCursorExpiredError } from '../src/types'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 四个 list 工具的分页协议。
 *
 * 收敛前它们有四套：集合键三个叫 `records`、一个叫 `items`；游标参数从「一个都没有」到「并列三个」；
 * 而 `list_model_request_records` 在 `scope: 'all'` 下把 `beforeSequence` 静默置空，于是翻页翻不动
 * 也不报错，消费者一直拿到同一页。现在对外只有 `limit` 与 `pageCursor`，结果只有 `items` 与
 * `nextPageCursor`，游标是服务端编码的不透明字符串。
 *
 * 断言全部经 `service.callTool`：游标的编码、解码与记录种类判定都在工具执行体这一侧，下降到记录库
 * 各自的方法会绕开它们。
 */

afterEach(async () => {
  await stopMcpTestApps()
})

type Page = {
  items: Array<Record<string, unknown>>
  nextPageCursor?: string
  hasMore?: boolean
  earliestCursor?: number
  capacity?: { recordCount: number }
}

type Harness = ReturnType<typeof createMcpTestService>

/** 一次分页读取；`callTool` 的返回值是 unknown，页形状在这里收一次。 */
async function readPage(harness: Harness, tool: string, args: Record<string, unknown>): Promise<Page> {
  return await harness.service.callTool(harness.credential.token, tool, args) as Page
}

/** 往某个记录库塞若干条模型请求记录，返回它们的标识。 */
function seedModelRequests(store: SandboxModelRequestStore, count: number, scopeId: string, prefix: string): string[] {
  return Array.from({ length: count }, (_unused, index) => store.append({
    status: 'success', durationMs: index + 1, model: `${prefix}-${index}`,
    attribution: 'attributed', entities: { scopeId }, requestBodyAvailable: false,
  }).id)
}

/** 编一个服务端形状的游标，用于构造消费者拿不到的输入（过期游标、伪造游标）。 */
function forgeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

describe('会话列表分页', () => {
  it('用返回的游标续页，翻到底后不再给游标', async () => {
    const harness = createMcpTestService(['read'])

    const all = await readPage(harness, 'list_conversations', { operatorId: '10001' })
    expect(all.items.map(({ id }) => id)).toEqual(['private:10001:20001', 'group:30001'])
    expect(all).not.toHaveProperty('nextPageCursor')

    const first = await readPage(harness, 'list_conversations', { operatorId: '10001', limit: 1 })
    expect(first.items.map(({ id }) => id)).toEqual(['private:10001:20001'])
    expect(typeof first.nextPageCursor).toBe('string')

    const second = await readPage(harness, 'list_conversations', { operatorId: '10001', limit: 1, pageCursor: first.nextPageCursor })
    expect(second.items.map(({ id }) => id)).toEqual(['group:30001'])
    expect(second).not.toHaveProperty('nextPageCursor')
  })

  it('退役的 offset 参数显式失败，不被无声忽略', async () => {
    const { service, credential } = createMcpTestService(['read'])

    // 被忽略的游标参数会让调用方以为自己在续页，实际每次都拿到第一页。
    await expect(service.callTool(credential.token, 'list_conversations', { operatorId: '10001', offset: 1 }))
      .rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('pageCursor') })
  })
})

describe('OneBot 调试记录分页', () => {
  it('正序与倒序都能用返回的游标续页，容量摘要与最早游标保留', async () => {
    const harness = createMcpTestService(['read', 'debug'])
    for (const action of ['first-action', 'second-action', 'third-action']) {
      harness.control.recordOneBotDebug({
        botId: '20001', implementation: 'napcat', direction: 'action',
        requestedAction: action, action, status: 'success', durationMs: 1,
      })
    }

    for (const order of ['desc', 'asc'] as const) {
      const first = await readPage(harness, 'list_onebot_debug_records', { order, limit: 2 })
      expect(first.items).toHaveLength(2)
      expect(first.hasMore).toBe(true)
      expect(first.capacity?.recordCount).toBe(3)
      expect(first.earliestCursor).toBe(1)

      const second = await readPage(harness, 'list_onebot_debug_records', { order, limit: 2, pageCursor: first.nextPageCursor })
      expect(second.items).toHaveLength(1)
      expect(second).not.toHaveProperty('nextPageCursor')
      // 两页拼起来正好是全部记录，顺序与一次读完的整页一致，没有重复也没有漏。
      const paged = [...first.items, ...second.items].map(({ id }) => id)
      const whole = await readPage(harness, 'list_onebot_debug_records', { order })
      expect(paged).toEqual(whole.items.map(({ id }) => id))
    }
  })

  it('退役的 beforeSequence 参数显式失败', async () => {
    const { service, credential } = createMcpTestService(['read', 'debug'])

    await expect(service.callTool(credential.token, 'list_onebot_debug_records', { beforeSequence: 2 }))
      .rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('beforeSequence') })
  })

  it('游标过期时恢复建议给出可直接使用的 pageCursor', async () => {
    const harness = createMcpTestService(['read', 'debug'])
    harness.control.recordOneBotDebug({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'kept-action', action: 'kept-action', status: 'success', durationMs: 1,
    })
    const store = harness.control.getOneBotDebugStore()
    const original = store.getRecords.bind(store)
    // 容量回收把最早几条抹掉之后指向它们的游标就会这样失败；构造异常比把记录库配到极小更直接。
    store.getRecords = () => Promise.reject(new SandboxOneBotDebugCursorExpiredError('调试记录游标已过期：1', 4))

    const expired = await harness.service.callTool(harness.credential.token, 'list_onebot_debug_records', {
      pageCursor: forgeCursor({ kind: 'onebot-debug-records', sequence: 1 }),
    }).then(() => undefined, (error: { code: string; recovery: string }) => error)
    expect(expired).toMatchObject({ code: 'cursor_expired', recovery: expect.stringContaining('pageCursor=') })

    // 恢复建议里的游标原样传回就能继续读，不必自己把数值拼回参数名。
    store.getRecords = original
    const recovered = /pageCursor=([A-Za-z0-9_-]+)/.exec(expired!.recovery)?.[1]
    expect(recovered).toBeTruthy()
    expect((await readPage(harness, 'list_onebot_debug_records', { pageCursor: recovered })).items)
      .toEqual([expect.objectContaining({ requestedAction: 'kept-action' })])
  })
})

describe('模型请求记录分页', () => {
  it('单记录域续页到底后不再给游标，联邦续页字段不出现在结果里', async () => {
    const harness = createMcpTestService(['read', 'debug'])
    seedModelRequests(harness.control.getModelRequestStore(), 3, 'main', 'main')

    const first = await readPage(harness, 'list_model_request_records', { scope: 'main', limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.capacity?.recordCount).toBe(3)
    // 容量摘要与最早游标原样带出：不透明游标只替换「消费者自己拼参数」这一段，不减少信息量。
    expect(first).toHaveProperty('earliestCursor')
    // 单记录域按序号续页，因此联邦读取那两个续页字段不出现在结果里。
    expect(first).not.toHaveProperty('nextCreatedAt')
    expect(first).not.toHaveProperty('nextId')

    const second = await readPage(harness, 'list_model_request_records', { scope: 'main', limit: 2, pageCursor: first.nextPageCursor })
    expect(second.items).toHaveLength(1)
    expect(second).not.toHaveProperty('nextPageCursor')
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(3)
  })

  it('scope=all 用返回的游标真的能翻到第二页', async () => {
    const harness = createMcpTestService(['read', 'debug', 'manage'], true)
    const space = harness.testSpaces.createSpace({ name: '联邦分页空间' })
    seedModelRequests(harness.control.getModelRequestStore(), 2, 'main', 'main')
    seedModelRequests(space.control.getModelRequestStore(), 2, space.id, 'space')

    const first = await readPage(harness, 'list_model_request_records', { scope: 'all', limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.hasMore).toBe(true)

    // 收敛前这条路径把 beforeSequence 静默置空，第二页与第一页逐字相同。
    const second = await readPage(harness, 'list_model_request_records', { scope: 'all', limit: 2, pageCursor: first.nextPageCursor })
    expect(second.items.map(({ id }) => id)).not.toEqual(first.items.map(({ id }) => id))
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(4)
  })

  it('单记录域与 scope=all 的游标不能互换，误用报参数错误', async () => {
    const harness = createMcpTestService(['read', 'debug', 'manage'], true)
    harness.testSpaces.createSpace({ name: '游标搭配空间' })
    seedModelRequests(harness.control.getModelRequestStore(), 3, 'main', 'main')

    const scoped = await readPage(harness, 'list_model_request_records', { scope: 'main', limit: 1 })
    const federated = await readPage(harness, 'list_model_request_records', { scope: 'all', limit: 1 })

    const call = (args: Record<string, unknown>) => harness.service.callTool(harness.credential.token, 'list_model_request_records', args)
    await expect(call({ scope: 'all', pageCursor: scoped.nextPageCursor }))
      .rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('scope=all') })
    await expect(call({ scope: 'main', pageCursor: federated.nextPageCursor }))
      .rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('单个记录域') })
  })

  /**
   * 联邦页的续页游标只在第二排序键跨记录域可比时给得出来，因此「还有更多但翻不过去」是一种真实
   * 状态。`hasMore` 必须独立于游标透出，否则消费者会以为自己读到底了。
   */
  it('联邦读取给不出续页游标时仍报出 hasMore', async () => {
    const harness = createMcpTestService(['read', 'debug', 'manage'], true)
    const space = harness.testSpaces.createSpace({ name: '不可续页空间' })
    space.control.getModelRequestStore().getRecords = async () => ({
      records: [],
      hasMore: true,
      capacity: { recordCount: 1, totalBytes: 1, maxRecords: 10, maxBytes: 10 },
    })

    const page = await readPage(harness, 'list_model_request_records', { scope: 'all' })
    expect(page.items).toEqual([])
    expect(page.hasMore).toBe(true)
    expect(page).not.toHaveProperty('nextPageCursor')
    // 容量摘要仍然逐项相加，不因为某个记录域翻不过去而丢掉。
    expect(page.capacity?.recordCount).toBe(1)
  })

  it('游标过期时恢复建议给出可直接使用的 pageCursor', async () => {
    const harness = createMcpTestService(['read', 'debug'])
    seedModelRequests(harness.control.getModelRequestStore(), 1, 'main', 'kept')
    const store = harness.control.getModelRequestStore()
    const original = store.getRecords.bind(store)
    store.getRecords = () => Promise.reject(new SandboxModelRequestCursorExpiredError('模型请求记录游标已过期：1', 7))

    const expired = await harness.service.callTool(harness.credential.token, 'list_model_request_records', {
      scope: 'main',
      pageCursor: forgeCursor({ kind: 'model-request-records', sequence: 1 }),
    }).then(() => undefined, (error: { code: string; recovery: string }) => error)
    expect(expired).toMatchObject({ code: 'cursor_expired', recovery: expect.stringContaining('pageCursor=') })

    store.getRecords = original
    const recovered = /pageCursor=([A-Za-z0-9_-]+)/.exec(expired!.recovery)?.[1]
    expect(recovered).toBeTruthy()
    // 恢复游标编的是最早仍在库里的序号；它是一个真能续页的输入，而不是一段要消费者自己拼的文案。
    expect(await readPage(harness, 'list_model_request_records', { scope: 'main', pageCursor: recovered }))
      .toMatchObject({ items: expect.any(Array) })
  })
})

describe('测试调用记录分页', () => {
  it('补上 limit 与续页，默认条数与另外三个一致', async () => {
    const harness = createMcpTestService(['read', 'debug'])
    for (let index = 0; index < 3; index += 1) {
      await harness.service.callTool(harness.credential.token, 'get_server_info', {})
    }

    const first = await readPage(harness, 'list_test_call_records', { tool: 'get_server_info', limit: 2 })
    expect(first.items).toHaveLength(2)

    const second = await readPage(harness, 'list_test_call_records', { tool: 'get_server_info', limit: 2, pageCursor: first.nextPageCursor })
    expect(second.items).toHaveLength(1)
    expect(second).not.toHaveProperty('nextPageCursor')
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(3)

    // 默认条数是 50：三条记录一次读完，没有续页游标。
    const whole = await readPage(harness, 'list_test_call_records', { tool: 'get_server_info' })
    expect(whole.items).toHaveLength(3)
    expect(whole).not.toHaveProperty('nextPageCursor')
    const limit = (harness.service.getCapabilityCatalog().tools.find(({ name }) => name === 'list_test_call_records')
      ?.inputSchema as { properties: { limit: { description: string } } }).properties.limit
    expect(limit.description).toContain('默认 50')
  })
})

describe('分页游标的种类判定', () => {
  it('把一种记录的游标传给另一种记录的工具时报参数错误', async () => {
    const harness = createMcpTestService(['read', 'debug'])
    seedModelRequests(harness.control.getModelRequestStore(), 2, 'main', 'cross-kind')

    const model = await readPage(harness, 'list_model_request_records', { scope: 'main', limit: 1 })
    const conversations = await readPage(harness, 'list_conversations', { operatorId: '10001', limit: 1 })

    const call = (tool: string, args: Record<string, unknown>) => harness.service.callTool(harness.credential.token, tool, args)
    await expect(call('list_onebot_debug_records', { pageCursor: model.nextPageCursor }))
      .rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('OneBot 调试记录') })
    await expect(call('list_test_call_records', { pageCursor: conversations.nextPageCursor }))
      .rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('测试调用记录') })
  })

  it('伪造或截断的游标报参数错误，不当成从头开始', async () => {
    const harness = createMcpTestService(['read'])
    const valid = (await readPage(harness, 'list_conversations', { operatorId: '10001', limit: 1 })).nextPageCursor!

    const broken = [
      '',
      '   ',
      '不是游标',
      valid.slice(0, valid.length - 4),
      // 能解析但字段不全：截断的游标解码后往往仍是一段合法 JSON 的前缀。
      forgeCursor({ kind: 'conversations' }),
      forgeCursor({ kind: 'conversations', offset: -1 }),
      forgeCursor({ kind: '别的记录', offset: 1 }),
      Buffer.from(JSON.stringify([{ kind: 'conversations', offset: 1 }]), 'utf8').toString('base64url'),
    ]
    for (const pageCursor of broken) {
      await expect(
        harness.service.callTool(harness.credential.token, 'list_conversations', { operatorId: '10001', pageCursor }),
        pageCursor,
      ).rejects.toMatchObject({ code: 'invalid_arguments' })
    }
  })
})
