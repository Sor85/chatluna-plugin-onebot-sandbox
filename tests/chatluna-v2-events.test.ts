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

const agent = { session: { id: 42 } }
const session = { selfId: 'bot-1', channelId: 'private:user-1' }

function step(turn: number, stepNumber: number, usage?: { inputTokens: number, outputTokens: number }) {
  return { usage, trace: { attributes: { turn, step: stepNumber } } }
}

describe('ChatLuna v2 agent 事件', () => {
  it('按 chat/receive 建立的会话映射记录 trace 位置、用量与等待态', () => {
    const { ctx, emit } = createHost()
    const archived: Array<{ result: SandboxMessageChatLuna, ids: readonly string[] }> = []
    const store = new SandboxChatLunaStateStore(ctx, () => true, () => {}, (_bot, _conversation, result, ids) => {
      archived.push({ result, ids })
    })

    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    expect(store.getStates()).toEqual([expect.objectContaining({ botParticipantId: 'bot-1', conversationId: 'private:user-1', thinking: true })])

    emit('chatluna/agent-step', { agent, step: step(3, 1, { inputTokens: 10, outputTokens: 2 }) })
    emit('chatluna/agent-step', { agent, step: step(3, 2, { inputTokens: 5, outputTokens: 4 }) })
    expect(store.traceFor('bot-1', 'private:user-1')).toEqual({ sessionId: '42', turn: 3, step: 2 })

    store.recordReplyMessage('bot-1', 'private:user-1', 'message-1')
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(store.getStates()[0]?.thinking).toBe(false)
    expect(archived).toEqual([{
      result: { thought: '', usage: { inputTokens: 15, outputTokens: 6, totalTokens: 21 } },
      ids: ['message-1'],
    }])
  })

  it('回合结束时没有捕获到回复 ID 就不归档，避免用量贴到上一轮的回复', () => {
    const { ctx, emit } = createHost()
    const archived: unknown[] = []
    new SandboxChatLunaStateStore(ctx, () => true, () => {}, (...args) => archived.push(args))
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1, { inputTokens: 1, outputTokens: 1 }) })
    emit('chatluna/agent-status', { agent, status: 'idle' })
    expect(archived).toEqual([])
  })

  it('会话出现新的用户消息后清空 trace，命令回复不沿用上一轮', () => {
    const { ctx, emit } = createHost()
    const store = new SandboxChatLunaStateStore(ctx, () => true)
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-step', { agent, step: step(1, 1) })
    expect(store.traceFor('bot-1', 'private:user-1')).toBeDefined()
    store.clearTraces('private:user-1')
    expect(store.traceFor('bot-1', 'private:user-1')).toBeUndefined()
  })

  it('不属于沙盒机器人的会话不建立映射', () => {
    const { ctx, emit } = createHost()
    const store = new SandboxChatLunaStateStore(ctx, () => false)
    emit('chat/receive', session, { sessionId: '42' })
    emit('chatluna/agent-status', { agent, status: 'busy' })
    emit('chatluna/agent-step', { agent, step: step(1, 1) })
    expect(store.getStates()).toEqual([])
    expect(store.traceFor('bot-1', 'private:user-1')).toBeUndefined()
  })
})
