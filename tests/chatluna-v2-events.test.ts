import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { SandboxChatLunaStateStore } from '../src/chatluna/state'
import type { SandboxMessageChatLuna } from '../src/types'

function createHost() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const ctx = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener))
    },
  } as unknown as Context
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  return { ctx, emit }
}

function createStore(resolve: (bot: string, channelId: string) => string | undefined = (_bot, channelId) => channelId) {
  const { ctx, emit } = createHost()
  const archived: Array<{ result: SandboxMessageChatLuna, ids: readonly string[] }> = []
  let changes = 0
  const store = new SandboxChatLunaStateStore(ctx, resolve, () => {
    changes += 1
  }, (_bot, _conversation, result, ids) => {
    archived.push({ result, ids: [...ids] })
  })
  return { store, emit, archived, changes: () => changes }
}

const agent = { session: { id: 42 } }
const session = { selfId: 'bot-1', channelId: 'private:user-1' }

function step(turn: number, stepNumber: number, options: { usage?: { inputTokens: number, outputTokens: number }, text?: string } = {}) {
  return {
    content: options.text ? [{ type: 'text', text: options.text }] : [],
    toolCalls: [],
    usage: options.usage,
    trace: { attributes: { turn, step: stepNumber } },
  }
}

describe('ChatLuna v2 agent 事件', () => {
  it('按 chat/receive 建立的会话映射记录 trace 位置、用量、内心活动与等待态', () => {
    const { store, emit, archived } = createStore()

    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    expect(store.getStates()).toEqual([expect.objectContaining({ botParticipantId: 'bot-1', conversationId: 'private:user-1', thinking: true })])

    emit('chatluna/agent-step', { agent, step: step(3, 1, { usage: { inputTokens: 10, outputTokens: 2 }, text: '<think>先查一下</think>' }) })
    emit('chatluna/agent-step', { agent, step: step(3, 2, { usage: { inputTokens: 12, outputTokens: 4 }, text: '<think>可以回了</think>好的' }) })
    expect(store.traceFor('bot-1', 'private:user-1')).toEqual({ sessionId: '42', turn: 3, step: 2 })

    store.recordReplyMessage('bot-1', 'private:user-1', 'message-1')
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(store.getStates()[0]?.thinking).toBe(false)
    expect(archived).toEqual([{
      result: {
        thought: '先查一下\n\n可以回了',
        thoughtDurationMs: expect.any(Number),
        usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
      },
      ids: ['message-1'],
    }])
  })

  it('busy 先于 chat/receive 到达（v2 dispatch 的真实顺序）时，映射建立后当场开始回合', () => {
    const { store, emit, archived } = createStore()
    emit('chatluna/agent-status', { agent, status: 'busy' })
    expect(store.getStates()).toEqual([])
    emit('chat/receive', session, { sessionId: '42' })
    expect(store.getStates()).toEqual([expect.objectContaining({ thinking: true })])

    emit('chatluna/agent-step', { agent, step: step(1, 1, { usage: { inputTokens: 2, outputTokens: 1 } }) })
    store.recordReplyMessage('bot-1', 'private:user-1', 'reply')
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(archived).toEqual([{ result: expect.objectContaining({ usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }), ids: ['reply'] }])
  })

  it('chat.wake 唤醒的回合没有 chat/receive，按 agent 打开时记下的路由位置补上映射，回复照样有出处', () => {
    const { store, emit, archived } = createStore()
    const woken = { session: { id: 'route:k' }, options: { location: { platform: 'onebot', selfId: 'bot-1', isDirect: true, channel: 'private:user-1', session: 'k' } } }
    emit('chatluna/agent-status', { agent: woken, status: 'busy' })
    expect(store.getStates()).toEqual([expect.objectContaining({ botParticipantId: 'bot-1', conversationId: 'private:user-1', thinking: true })])

    emit('chatluna/span-start', { span: { spanKind: 'step', session: 'route:k', attributes: { turn: 1, step: 1 } } })
    expect(store.traceFor('bot-1', 'private:user-1')).toEqual({ sessionId: 'route:k', turn: 1, step: 1 })
    emit('chatluna/agent-step', { agent: woken, step: step(1, 1, { usage: { inputTokens: 3, outputTokens: 1 } }) })
    store.recordReplyMessage('bot-1', 'private:user-1', 'reply')
    emit('chatluna/agent-status', { agent: woken, status: 'idle' })
    expect(archived).toEqual([{ result: expect.objectContaining({ usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }), ids: ['reply'] }])
  })

  it('路由位置解析不到沙盒会话时同样不建立映射', () => {
    const { store, emit } = createStore(() => undefined)
    emit('chatluna/agent-status', { agent: { session: { id: 'x' }, options: { location: { selfId: 'bot-1', channel: 'private:user-1' } } }, status: 'busy' })
    expect(store.getStates()).toEqual([])
  })

  it('agent 已经 idle 时晚到的 chat/receive 不开始回合', () => {
    const { store, emit } = createStore()
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-status', { agent, status: 'idle' })
    emit('chat/receive', session, { sessionId: '42' })
    expect(store.getStates()).toEqual([])
  })

  it('回复晚于 idle 发出时由之后发出的回复接手结果，分段越多越往后移', () => {
    const { store, emit, archived } = createStore()
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1, { usage: { inputTokens: 1, outputTokens: 1 }, text: '<think>想想</think>' }) })
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(archived).toEqual([])

    store.recordReplyMessage('bot-1', 'private:user-1', 'segment-1')
    store.recordReplyMessage('bot-1', 'private:user-1', 'segment-2')
    expect(archived.map(({ ids }) => ids)).toEqual([['segment-1'], ['segment-1', 'segment-2']])
    expect(archived[1]?.result).toEqual(expect.objectContaining({ thought: '想想', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }))
  })

  it('回合内已发出的回复与 idle 之后的分段同属一轮', () => {
    const { store, emit, archived } = createStore()
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1, { text: '<think>想想</think>' }) })
    store.recordReplyMessage('bot-1', 'private:user-1', 'segment-1')
    emit('chatluna/agent-status', { agent, status: 'idle' })
    store.recordReplyMessage('bot-1', 'private:user-1', 'segment-2')
    expect(archived.map(({ ids }) => ids)).toEqual([['segment-1'], ['segment-1', 'segment-2']])
  })

  it('会话出现新的用户消息后挂起的结果与 trace 一起作废，命令回复不沿用上一轮', () => {
    const { store, emit, archived } = createStore()
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1, { usage: { inputTokens: 1, outputTokens: 1 } }) })
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(store.traceFor('bot-1', 'private:user-1')).toBeDefined()

    store.clearReplyContext('private:user-1')
    store.recordReplyMessage('bot-1', 'private:user-1', 'command-reply')
    expect(store.traceFor('bot-1', 'private:user-1')).toBeUndefined()
    expect(archived).toEqual([])
  })

  it('新回合开始时上一轮挂起的结果作废', () => {
    const { store, emit, archived } = createStore()
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1, { text: '<think>上一轮</think>' }) })
    emit('chatluna/agent-status', { agent, status: 'idle' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    store.recordReplyMessage('bot-1', 'private:user-1', 'next-reply')
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(archived).toEqual([])
  })

  it('上一轮因上游报错没收到 idle 时，新回合的用量与内心活动从这一轮算起', () => {
    const { store, emit, archived } = createStore()
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1, { usage: { inputTokens: 100, outputTokens: 100 }, text: '<think>中断的一轮</think>' }) })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(2, 1, { usage: { inputTokens: 1, outputTokens: 1 }, text: '<think>这一轮</think>' }) })
    store.recordReplyMessage('bot-1', 'private:user-1', 'reply')
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(archived).toEqual([{
      result: expect.objectContaining({ thought: '这一轮', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
      ids: ['reply'],
    }])
  })

  it('并发的 agent 会话各自收尾，用量与回复互不串联', () => {
    const { store, emit, archived } = createStore()
    const other = { session: { id: 'other' } }
    emit('chat/receive', session, { sessionId: '42' })
    emit('chat/receive', { selfId: 'bot-2', channelId: 'group:30001' }, { sessionId: 'other' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-status', { agent: other, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1, { usage: { inputTokens: 1, outputTokens: 1 } }) })
    emit('chatluna/agent-step', { agent: other, step: step(1, 1, { usage: { inputTokens: 7, outputTokens: 3 } }) })
    store.recordReplyMessage('bot-1', 'private:user-1', 'direct-reply')
    store.recordReplyMessage('bot-2', 'group:30001', 'group-reply')

    emit('chatluna/agent-status', { agent: other, status: 'idle' })
    expect(store.getStates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ botParticipantId: 'bot-1', thinking: true }),
      expect.objectContaining({ botParticipantId: 'bot-2', thinking: false }),
    ]))
    expect(archived).toEqual([{ result: expect.objectContaining({ usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }), ids: ['group-reply'] }])
  })

  it('开始与结束都广播变更，没有内心活动与用量的回合不归档', () => {
    const { store, emit, archived, changes } = createStore()
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    store.recordReplyMessage('bot-1', 'private:user-1', 'reply')
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(changes()).toBe(2)
    expect(archived).toEqual([])
  })

  it('不属于沙盒机器人的会话不建立映射，也不广播', () => {
    const { store, emit, changes } = createStore(() => undefined)
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1) })
    expect(store.getStates()).toEqual([])
    expect(store.traceFor('bot-1', 'private:user-1')).toBeUndefined()
    expect(changes()).toBe(0)
  })

  it('删除机器人后它的会话映射与挂起结果一并清掉', () => {
    const { store, emit, archived } = createStore()
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1, { text: '<think>想想</think>' }) })
    emit('chatluna/agent-status', { agent, status: 'idle' })
    store.deleteByBotParticipant('bot-1')
    store.recordReplyMessage('bot-1', 'private:user-1', 'reply')
    emit('chatluna/agent-status', { agent, status: 'busy' })
    expect(archived).toEqual([])
    expect(store.getStates()).toEqual([])
  })
})
