import { h } from '@satorijs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INBOUND_MIDDLEWARE_TIMEOUT_MS,
  createInboundDelivery,
  createInboundEventConversations,
  type DeliverInboundMessageInput,
  type InboundDeliveryBot,
  type InboundDeliverySession,
  type InboundMessageContext,
} from '../src/inbound-delivery'
import type { AppendOneBotDebugRecordInput } from '../src/onebot-debug'
import type { SandboxChannelAssigneeTarget } from '../src/channel-assignee'
import type { ResolvedConversation } from '../src/conversation-resolution'
import type { SandboxBotDelivery, SandboxBotProfile, SandboxGroup, SandboxParticipant } from '../src/types'

/**
 * 投递模块的协作者全部按注入取得，因此这一族用例不开 Koishi 运行时。
 *
 * 它们与 `message-delivery.test.ts` 那六个用真 `App` 驱动的用例不互相替代：一个证明推导与规则
 * 本身，一个证明接线。
 */

const DIRECT: ResolvedConversation = {
  id: 'private:10001:20001',
  kind: 'root',
  rootConversationId: 'private:10001:20001',
  type: 'direct',
  participantIds: ['10001', '20001'],
}

const GROUP: ResolvedConversation = {
  id: 'group:30001',
  kind: 'root',
  rootConversationId: 'group:30001',
  type: 'group',
  groupId: '30001',
}

const USER: SandboxParticipant = { kind: 'user', id: '10001', name: '测试用户1' }

function bot(id: string, enabled = true): SandboxBotProfile {
  return { kind: 'bot', id, name: `机器人${id}`, implementation: 'napcat', enabled }
}

function group(...memberIds: string[]): SandboxGroup {
  return {
    id: '30001',
    name: '测试群',
    members: memberIds.map((participantId) => ({ participantId, role: 'member' as const })),
    announcements: [],
  }
}

interface FakeBot extends InboundDeliveryBot {
  readonly dispatched: InboundDeliverySession[]
  /** 派发期间窗口给出的会话，用来证明窗口在插件真正有机会回复的那段时间里可见。 */
  readonly observedDuringDispatch: Array<string | undefined>
  failNextDispatch?: Error
}

interface Harness {
  readonly runtimeBots: Map<string, FakeBot>
  readonly deliveries: SandboxBotDelivery[]
  readonly debugRecords: AppendOneBotDebugRecordInput[]
  readonly warnings: unknown[][]
  readonly errors: unknown[][]
  readonly channelAlignments: SandboxChannelAssigneeTarget[]
  readonly middlewareListeners: Set<(session: InboundDeliverySession) => void>
  readonly eventConversations: ReturnType<typeof createInboundEventConversations>
  readonly delivery: ReturnType<typeof createInboundDelivery>
  finishMiddleware(): void
  addBot(profile: SandboxBotProfile): FakeBot
}

function createHarness(options: { followFails?: Error; alignFails?: Error } = {}): Harness {
  const profiles = new Map<string, SandboxBotProfile>()
  const runtimeBots = new Map<string, FakeBot>()
  const deliveries: SandboxBotDelivery[] = []
  const debugRecords: AppendOneBotDebugRecordInput[] = []
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  const channelAlignments: SandboxChannelAssigneeTarget[] = []
  const middlewareListeners = new Set<(session: InboundDeliverySession) => void>()
  const eventConversations = createInboundEventConversations()
  let nextSessionId = 1

  const delivery = createInboundDelivery({
    getRuntimeBot: (botId) => runtimeBots.get(botId),
    getBotProfile: (botId) => profiles.get(botId),
    onMiddlewareFinished: (listener) => {
      middlewareListeners.add(listener)
      return () => middlewareListeners.delete(listener)
    },
    recordDebug: (input) => debugRecords.push(input),
    recordDelivery: (record) => deliveries.push(record),
    followInboundConversation: async () => {
      if (options.followFails) throw options.followFails
      return true
    },
    alignChannelAssignee: async (input) => {
      if (options.alignFails) throw options.alignFails
      channelAlignments.push(input)
      return true
    },
    logger: {
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
    eventConversations,
  })

  const harness: Harness = {
    runtimeBots,
    deliveries,
    debugRecords,
    warnings,
    errors,
    channelAlignments,
    middlewareListeners,
    eventConversations,
    delivery,
    finishMiddleware() {
      for (const runtime of runtimeBots.values()) {
        for (const session of runtime.dispatched) {
          for (const listener of [...middlewareListeners]) listener(session)
        }
      }
    },
    addBot(profile) {
      profiles.set(profile.id, profile)
      const runtime: FakeBot = {
        selfId: profile.id,
        dispatched: [],
        observedDuringDispatch: [],
        session: (event) => ({ id: nextSessionId++, ...event } as unknown as InboundDeliverySession),
        dispatch(session) {
          runtime.observedDuringDispatch.push(eventConversations.current(profile.id))
          runtime.dispatched.push(session)
          if (runtime.failNextDispatch) {
            const error = runtime.failNextDispatch
            runtime.failNextDispatch = undefined
            throw error
          }
        },
      }
      runtimeBots.set(profile.id, runtime)
      return runtime
    },
  }
  return harness
}

/** 消息标识必须是十六进制：OneBot 消息序号由它按十六进制解析而来。 */
function messageInput(context: InboundMessageContext, messageId = 'ab01cd02'): DeliverInboundMessageInput {
  return {
    context,
    messageId,
    elements: [h.text('你好')],
    segments: [{ type: 'text', data: { text: '你好' } }],
    rawMessage: '你好',
  }
}

/** 让投递跑到「已派发、正在等中间件」这一步：中间跨过角色上下文跟随那一次 await。 */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/** 投递会等中间件结束，因此驱动它必须一边等一边放行。 */
async function deliverAndFinish(harness: Harness, input: DeliverInboundMessageInput): Promise<void> {
  const settled = harness.delivery.deliverMessage(input)
  await flushMicrotasks()
  harness.finishMiddleware()
  await settled
}

afterEach(() => {
  vi.useRealTimers()
})

describe('入站投递：接收机器人推导', () => {
  it('私聊只投递给对端机器人', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001'))
    harness.addBot(bot('20002'))

    await deliverAndFinish(harness, messageInput({ operator: USER, peer: bot('20001'), conversation: DIRECT }))

    expect(harness.deliveries.map(({ recipientBotId }) => recipientBotId)).toEqual(['20001'])
  })

  it('私聊对端机器人已停用时不投递', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001', false))

    await deliverAndFinish(harness, messageInput({ operator: USER, peer: bot('20001', false), conversation: DIRECT }))

    expect(harness.deliveries).toEqual([])
  })

  it('群消息投递给全部启用的机器人成员，停用的不收', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001'))
    harness.addBot(bot('20002'))
    harness.addBot(bot('20003', false))

    await deliverAndFinish(harness, messageInput({
      operator: USER,
      conversation: GROUP,
      group: group('10001', '20001', '20002', '20003'),
    }))

    expect(harness.deliveries.map(({ recipientBotId }) => recipientBotId).sort()).toEqual(['20001', '20002'])
  })

  it('机器人自己发群消息时被排除，避免形成自我调用环', async () => {
    const harness = createHarness()
    const operator = bot('20001')
    harness.addBot(operator)
    harness.addBot(bot('20002'))

    await deliverAndFinish(harness, messageInput({
      operator,
      conversation: GROUP,
      group: group('20001', '20002'),
    }))

    expect(harness.deliveries.map(({ recipientBotId }) => recipientBotId)).toEqual(['20002'])
  })

  it('一条群消息复用同一个消息标识派发给多个机器人', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001'))
    harness.addBot(bot('20002'))

    await deliverAndFinish(harness, messageInput({
      operator: USER,
      conversation: GROUP,
      group: group('10001', '20001', '20002'),
    }, 'beef0001'))

    expect(harness.deliveries).toEqual([
      expect.objectContaining({ recipientBotId: '20001', messageId: 'beef0001', conversationId: 'group:30001' }),
      expect.objectContaining({ recipientBotId: '20002', messageId: 'beef0001', conversationId: 'group:30001' }),
    ])
    expect(harness.deliveries.every(({ createdAt, id }) => !!createdAt && !!id)).toBe(true)
  })

  it('接收机器人的运行时缺席时投递失败，不静默跳过', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001'))
    harness.runtimeBots.delete('20001')

    await expect(harness.delivery.deliverMessage(messageInput({
      operator: USER,
      peer: bot('20001'),
      conversation: DIRECT,
    }))).rejects.toThrow('机器人运行时不存在：20001')
  })
})


describe('入站投递：中间件等待', () => {
  it('中间件迟迟不结束时，推过超时点后投递照常结束且监听器被解除', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.addBot(bot('20001'))

    const settled = harness.delivery.deliverMessage(messageInput({ operator: USER, peer: bot('20001'), conversation: DIRECT }))
    let done = false
    void settled.then(() => {
      done = true
    })
    // 中间件永不结束：只推时间，不放行监听器。
    await vi.advanceTimersByTimeAsync(INBOUND_MIDDLEWARE_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    expect(harness.middlewareListeners.size).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    await settled

    expect(done).toBe(true)
    expect(harness.middlewareListeners.size).toBe(0)
    expect(harness.deliveries).toHaveLength(1)
  })

  it('中间件按时结束时不等到超时点，监听器同样被解除', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.addBot(bot('20001'))

    const settled = harness.delivery.deliverMessage(messageInput({ operator: USER, peer: bot('20001'), conversation: DIRECT }))
    await flushMicrotasks()
    harness.finishMiddleware()
    await settled

    expect(harness.middlewareListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('别的会话结束中间件不算本次派发结束', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.addBot(bot('20001'))

    const settled = harness.delivery.deliverMessage(messageInput({ operator: USER, peer: bot('20001'), conversation: DIRECT }))
    let done = false
    void settled.then(() => {
      done = true
    })
    await flushMicrotasks()
    for (const listener of [...harness.middlewareListeners]) listener({ id: 9999 })
    await flushMicrotasks()
    expect(done).toBe(false)

    harness.finishMiddleware()
    await settled
    expect(done).toBe(true)
  })
})

describe('入站投递：Koishi channel 受理人对齐', () => {
  it('群消息在派发之前按收件机器人对齐受理人，每个机器人各一次', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001'))
    harness.addBot(bot('20002'))

    await deliverAndFinish(harness, messageInput({
      operator: USER,
      conversation: GROUP,
      group: group('10001', '20001', '20002'),
    }))

    expect(harness.channelAlignments).toEqual([
      { botId: '20001', channelId: '30001', groupId: '30001' },
      { botId: '20002', channelId: '30001', groupId: '30001' },
    ])
  })

  it('私聊不对齐：Koishi 的受理人判定只在群聊生效', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001'))

    await deliverAndFinish(harness, messageInput({ operator: USER, peer: bot('20001'), conversation: DIRECT }))

    expect(harness.channelAlignments).toEqual([])
  })

  it('对齐抛错时投递仍然完成、插件仍然收到事件，只多一条日志', async () => {
    const failure = new Error('数据库不可用')
    const harness = createHarness({ alignFails: failure })
    const runtime = harness.addBot(bot('20001'))

    await deliverAndFinish(harness, messageInput({
      operator: USER,
      conversation: GROUP,
      group: group('10001', '20001'),
    }))

    expect(runtime.dispatched).toHaveLength(1)
    expect(harness.deliveries).toHaveLength(1)
    expect(harness.warnings).toEqual([[expect.stringContaining('对齐 Koishi channel 受理人失败'), failure]])
  })
})

describe('入站投递：ChatLuna 会话跟随对话线', () => {
  it('跟随抛错时投递仍然完成、插件仍然收到事件，只多一条日志', async () => {
    const harness = createHarness({ followFails: new Error('chat 服务不可用') })
    const runtime = harness.addBot(bot('20001'))

    await deliverAndFinish(harness, messageInput({ operator: USER, peer: bot('20001'), conversation: DIRECT }))

    expect(runtime.dispatched).toHaveLength(1)
    expect(harness.deliveries).toHaveLength(1)
    expect(harness.warnings).toEqual([[
      '切换 ChatLuna 会话失败；这一轮可能带上另一条对话线或另一个测试空间的历史。',
      expect.any(Error),
    ]])
  })
})

describe('入站投递：入站事件会话', () => {
  it('投递期间可见，投递结束后弹出', async () => {
    const harness = createHarness()
    const runtime = harness.addBot(bot('20001'))

    await deliverAndFinish(harness, messageInput({ operator: USER, peer: bot('20001'), conversation: DIRECT }))

    expect(runtime.observedDuringDispatch).toEqual(['private:10001:20001'])
    expect(harness.eventConversations.current('20001')).toBeUndefined()
  })

  it('嵌套派发取最内层，退出后回到外层', async () => {
    const conversations = createInboundEventConversations()
    const observed: Array<string | undefined> = []

    await conversations.run('20001', '外层', async () => {
      observed.push(conversations.current('20001'))
      await conversations.run('20001', '内层', async () => {
        observed.push(conversations.current('20001'))
      })
      observed.push(conversations.current('20001'))
    })
    observed.push(conversations.current('20001'))

    expect(observed).toEqual(['外层', '内层', '外层', undefined])
  })

  it('派发抛错时窗口同样弹出，不留下过期的会话', async () => {
    const conversations = createInboundEventConversations()

    await expect(conversations.run('20001', '会话', async () => {
      throw new Error('派发失败')
    })).rejects.toThrow('派发失败')

    expect(conversations.current('20001')).toBeUndefined()
  })

  it('两个机器人各自一份窗口，互不影响', async () => {
    const conversations = createInboundEventConversations()

    await conversations.run('20001', '第一个会话', async () => {
      await conversations.run('20002', '第二个会话', async () => {
        expect(conversations.current('20001')).toBe('第一个会话')
        expect(conversations.current('20002')).toBe('第二个会话')
      })
      expect(conversations.current('20002')).toBeUndefined()
    })
  })
})

describe('入站投递：事件派发与调试记录', () => {
  it('六种事件都经共用底座，动作名按 post_type 与它自己那一维的细分类型拼出', async () => {
    const harness = createHarness()
    const runtime = harness.addBot(bot('20001'))
    const payloads = [
      { post_type: 'message', message_type: 'private' },
      { post_type: 'request', request_type: 'friend' },
      { post_type: 'notice', notice_type: 'friend_del' },
      { post_type: 'request', request_type: 'group' },
      { post_type: 'notice', notice_type: 'group_increase' },
      { post_type: 'notice', notice_type: 'friend_recall' },
    ]

    for (const [index, onebot] of payloads.entries()) {
      await harness.delivery.dispatchEvent(runtime, { id: 100 + index, onebot } as unknown as InboundDeliverySession)
    }

    expect(harness.debugRecords.map(({ action }) => action)).toEqual([
      'message.private',
      'request.friend',
      'notice.friend_del',
      'request.group',
      'notice.group_increase',
      'notice.friend_recall',
    ])
    expect(harness.debugRecords[0]).toEqual({
      botId: '20001',
      implementation: 'napcat',
      direction: 'event',
      requestedAction: 'message.private',
      action: 'message.private',
      status: 'success',
      durationMs: expect.any(Number),
      payload: payloads[0],
      result: { delivered: true },
    })
  })

  it('载荷缺少事件类型时动作名归一成 unknown，而不是崩在记录上', async () => {
    const harness = createHarness()
    const runtime = harness.addBot(bot('20001'))

    await harness.delivery.dispatchEvent(runtime, { id: 1 } as unknown as InboundDeliverySession)

    expect(harness.debugRecords.map(({ action }) => action)).toEqual(['unknown'])
  })

  it('派发失败时记一条错误记录、写一条日志并原样抛出', async () => {
    const harness = createHarness()
    const runtime = harness.addBot(bot('20001'))
    const failure = new Error('插件监听器抛错')
    runtime.failNextDispatch = failure

    await expect(harness.delivery.dispatchEvent(
      runtime,
      { id: 1, onebot: { post_type: 'message', message_type: 'group' } } as unknown as InboundDeliverySession,
    )).rejects.toBe(failure)

    expect(harness.debugRecords).toEqual([expect.objectContaining({
      direction: 'event',
      action: 'message.group',
      status: 'error',
      error: expect.objectContaining({ message: '插件监听器抛错', traceId: expect.any(String) }),
    })])
    expect(harness.errors).toEqual([[expect.stringContaining('OneBot 原始事件派发失败'), failure]])
  })

  it('投递中派发失败时不写投递记录，且窗口已经弹出', async () => {
    const harness = createHarness()
    const runtime = harness.addBot(bot('20001'))
    runtime.failNextDispatch = new Error('插件监听器抛错')

    await expect(harness.delivery.deliverMessage(messageInput({
      operator: USER,
      peer: bot('20001'),
      conversation: DIRECT,
    }))).rejects.toThrow('插件监听器抛错')

    expect(harness.deliveries).toEqual([])
    expect(harness.eventConversations.current('20001')).toBeUndefined()
    expect(harness.middlewareListeners.size).toBe(0)
  })

  it('机器人档案缺席时按「机器人不存在」失败', async () => {
    const harness = createHarness()
    const runtime = harness.addBot(bot('20001'))

    await expect(harness.delivery.dispatchEvent(
      { ...runtime, selfId: '29999' },
      { id: 1 } as unknown as InboundDeliverySession,
    )).rejects.toThrow('机器人不存在：29999')
  })

  it('派发之前失败时同样记一条错误记录与一行日志，不留无痕失败', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001'))
    harness.runtimeBots.delete('20001')

    await expect(harness.delivery.deliverMessage(messageInput({
      operator: USER,
      peer: bot('20001'),
      conversation: DIRECT,
    }))).rejects.toThrow('机器人运行时不存在：20001')

    expect(harness.debugRecords).toEqual([expect.objectContaining({
      botId: '20001',
      direction: 'event',
      action: 'message.private',
      status: 'error',
      error: expect.objectContaining({ message: '机器人运行时不存在：20001', traceId: expect.any(String) }),
    })])
    expect(harness.errors).toEqual([[
      expect.stringContaining('入站消息投递在派发之前失败'),
      expect.objectContaining({ message: '机器人运行时不存在：20001' }),
    ]])
  })

  it('派发之前失败的记录带上完整载荷，看记录就知道丢的是哪一条消息', async () => {
    const harness = createHarness()
    harness.addBot(bot('20001'))
    harness.runtimeBots.delete('20001')

    await expect(harness.delivery.deliverMessage(messageInput({
      operator: USER,
      conversation: GROUP,
      group: group('10001', '20001'),
    }, 'beef0002'))).rejects.toThrow('机器人运行时不存在：20001')

    expect(harness.debugRecords[0]).toEqual(expect.objectContaining({
      action: 'message.group',
      payload: expect.objectContaining({
        post_type: 'message',
        message_type: 'group',
        self_id: 20001,
        user_id: 10001,
        group_id: 30001,
        raw_message: '你好',
        message: [{ type: 'text', data: { text: '你好' } }],
      }),
    }))
  })

  it('派发自身失败时只记一条，投递层不重复记账', async () => {
    const harness = createHarness()
    const runtime = harness.addBot(bot('20001'))
    runtime.failNextDispatch = new Error('插件监听器抛错')

    await expect(harness.delivery.deliverMessage(messageInput({
      operator: USER,
      peer: bot('20001'),
      conversation: DIRECT,
    }))).rejects.toThrow('插件监听器抛错')

    expect(harness.debugRecords).toHaveLength(1)
    expect(harness.errors).toEqual([[expect.stringContaining('OneBot 原始事件派发失败'), expect.any(Error)]])
  })
})

