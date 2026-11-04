import { afterEach, describe, expect, it } from 'vitest'
import { SANDBOX_MCP_EVENT_TYPES } from '../src/mcp/types'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 事件类型是封闭词汇，与稳定错误码同一个形状：消费者只能从对外声明学到全集。
 *
 * 此前 `wait_for_event` 的 `type` 是自由字符串，只在描述里举了三个例子。写错一个名字既不报错也
 * 匹配不上，只能等到超时返回 `outcome: 'timeout'`——那与「游标之后真的没有这个事件」的观察结果完全
 * 一样，消费者据此得出的是错的结论。
 *
 * 声明侧三处必须同源：`wait_for_event` 的 enum、只读资源、以及事件类型常量本身。实现侧不必再靠
 * 守卫扫描源码——`appendEvent` 的形参就是这个联合类型，追加未登记的类型过不了类型检查。
 */

afterEach(async () => {
  await stopMcpTestApps()
})

describe('事件类型封闭词汇', () => {
  it('工具声明的取值集合、只读资源与事件类型常量三处一致', () => {
    const { service, credential } = createMcpTestService(['read'])

    const declared = service.getCapabilityCatalog().tools.find(({ name }) => name === 'wait_for_event')
    const type = (declared?.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties?.type
    expect(type?.enum).toEqual([...SANDBOX_MCP_EVENT_TYPES])
    expect(service.readResource(credential.token, 'onebot-sandbox://events')).toEqual([...SANDBOX_MCP_EVENT_TYPES])
    // 与错误码资源同一条要求：不得有重复项，否则消费者读到的集合与实现不是一一对应。
    expect(new Set(SANDBOX_MCP_EVENT_TYPES).size).toBe(SANDBOX_MCP_EVENT_TYPES.length)
  })

  it('取值集合之外的事件类型立刻报错，并在消息里给出集合', async () => {
    const { service, credential } = createMcpTestService(['read', 'interact'])
    const { cursor } = await service.callTool(credential.token, 'get_server_info', {}) as { cursor: unknown }

    const failure = await service.callTool(credential.token, 'wait_for_event', { cursor, type: 'message', timeoutSeconds: 1 })
      .then(() => undefined, (error: { code: string, message: string }) => error)

    expect(failure).toMatchObject({ code: 'invalid_arguments' })
    expect(failure!.message).toContain('message.created')
  })

  it('登记在集合里的类型照旧可以等待', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'interact'])
    const { cursor } = await service.callTool(credential.token, 'get_server_info', {}) as { cursor: unknown }

    control.createUser({ id: '19801', name: '事件用户' })
    await expect(service.callTool(credential.token, 'wait_for_event', {
      cursor,
      type: 'scene.changed',
      timeoutSeconds: 1,
    })).resolves.toMatchObject({ outcome: 'matched', event: { type: 'scene.changed' } })
  })
})

describe('按调用结果筛选记录', () => {
  it('调试记录能只看成功的，也能只看失败的', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'debug'])
    control.recordOneBotDebug({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'ok-action', action: 'ok-action', status: 'success', durationMs: 1,
    })
    control.recordOneBotDebug({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'bad-action', action: 'bad-action', status: 'error', durationMs: 2,
    })

    const read = async (status?: string) => {
      const page = await service.callTool(credential.token, 'list_onebot_debug_records', status ? { status } : {}) as {
        items: Array<{ requestedAction: string }>
      }
      return page.items.map(({ requestedAction }) => requestedAction).sort()
    }

    // 「只看成功的」是布尔参数表达不了的那一半，也是这次换成状态枚举的理由。
    expect(await read('success')).toEqual(['ok-action'])
    expect(await read('error')).toEqual(['bad-action'])
    expect(await read()).toEqual(['bad-action', 'ok-action'])
  })

  it('模型请求记录能按还在飞的状态筛选', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'debug'])
    const store = control.getModelRequestStore()
    store.append({ status: 'pending', durationMs: 0, model: 'flying', attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false })
    store.append({ status: 'success', durationMs: 1, model: 'landed', attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false })

    const page = await service.callTool(credential.token, 'list_model_request_records', { scope: 'main', status: 'pending' }) as {
      items: Array<{ model: string }>
    }
    expect(page.items.map(({ model }) => model)).toEqual(['flying'])
  })

  it('取值集合之外的筛选值与排序值都显式失败，不当成不筛选', async () => {
    const { service, credential } = createMcpTestService(['read', 'debug'])

    for (const args of [{ status: 'faild' }, { order: 'ascending' }, { direction: 'actions' }]) {
      await expect(service.callTool(credential.token, 'list_onebot_debug_records', args))
        .rejects.toMatchObject({ code: 'invalid_arguments' })
    }
    await expect(service.callTool(credential.token, 'list_test_call_records', { transport: 'websocket' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
  })
})
