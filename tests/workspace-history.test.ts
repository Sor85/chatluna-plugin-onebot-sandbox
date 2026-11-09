import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxForward, SandboxMessage, SandboxMessageHistory } from '../src/types'
import { readConversationMessageIds } from '../src/conversation-resolution'
import { conversationMessagesOf, WorkspaceStore } from '../client/workspace/store'
import { deferred } from './helpers/deferred'
import { workspaceFor } from './helpers/workspace'

const { callAction, storage } = vi.hoisted(() => ({
  callAction: vi.fn(),
  storage: new Map<string, unknown>(),
}))
vi.mock('@chatluna/ui-client/client', () => ({ callAction }))
vi.mock('@chatluna/ui-storage', () => ({
  readStored: (key: string) => storage.get(key),
  writeStored: (key: string, value: unknown) => storage.set(key, value),
}))

const conversationId = 'private:10003:20001'
const createdAt = '2026-01-01T00:00:00.000Z'
const forward: SandboxForward = {
  id: 'forward-a', authorId: '10003', createdAt,
  nodes: [{ userId: '10003', nickname: 'A', content: 'A 的转发内容', createdAt }],
}
const message = (id: string, target = conversationId): SandboxMessage => ({
  id, authorId: '20001', conversationId: target, content: id, createdAt,
})

function createStore(instance = false) {
  const workspace = workspaceFor('10003')
  const id = instance ? 'history-instance' : conversationId
  if (instance) {
    workspace.snapshot.conversationInstances.push({
      id, rootConversationId: conversationId, title: '历史测试', messageIds: ['m3'], hasMoreMessages: true,
    })
  } else {
    Object.assign(workspace.snapshot.conversations.find(({ id: value }) => value === id)!, {
      messageIds: ['m3'], hasMoreMessages: true,
    })
  }
  workspace.snapshot.messages.push(message('m3', id))
  const store = new WorkspaceStore(undefined)
  store.seed(workspace)
  return { store, id }
}

beforeEach(() => {
  callAction.mockReset()
  storage.clear()
  storage.set('chatluna.onebot-sandbox.selection.main', {
    currentOperatorId: '10003', activeConversationId: conversationId,
  })
})

describe('历史与转发读取的视角隔离', () => {
  describe.each(['history', 'forward'] as const)('%s', (kind) => {
    it.each(['switch', 'switch-back', 'dispose', 'remount'] as const)('%s 后丢弃旧响应，不返回或缓存旧视角内容', async (change) => {
      const { store, id } = createStore()
      const response = deferred<SandboxMessageHistory | SandboxForward>()
      callAction.mockImplementation((name: string, input: { operatorId?: string }) => name === 'onebot-sandbox.workspace'
        ? Promise.resolve(workspaceFor(input.operatorId))
        : response.promise)
      const pending = kind === 'history'
        ? store.loadEarlierMessages(id)
        : store.getForwardMessage({ forwardId: forward.id })
      if (change === 'switch' || change === 'switch-back') {
        await store.selectOperator('10001')
        if (change === 'switch-back') await store.selectOperator('10003')
      } else {
        store.dispose()
        if (change === 'remount') store.activate()
      }
      const before = store.getView()
      response.settle(kind === 'history' ? { messages: [message('m1')], forwards: [forward] } : forward)
      expect(await pending).toBeUndefined()
      expect(store.getView()).toBe(before)
      expect(store.snapshot?.messages.some(({ id }) => id === 'm1')).toBe(false)
      expect(store.snapshot?.forwards).toEqual([])
    })

    it('切换后到达的请求失败不再打扰新视角', async () => {
      const { store, id } = createStore()
      const response = deferred<never>()
      callAction.mockImplementation((name: string, input: { operatorId?: string }) => name === 'onebot-sandbox.workspace'
        ? Promise.resolve(workspaceFor(input.operatorId))
        : response.promise)
      const pending = kind === 'history'
        ? store.loadEarlierMessages(id)
        : store.getForwardMessage({ forwardId: forward.id })
      await store.selectOperator('10001')
      response.fail(new Error('旧请求连接中断'))
      await expect(pending).resolves.toBeUndefined()
    })
  })

  it('有效的转发响应正常返回，重复读取不重复缓存', async () => {
    const { store } = createStore()
    callAction.mockResolvedValue(forward)
    expect(await store.getForwardMessage({ forwardId: forward.id })).toEqual(forward)
    expect(await store.getForwardMessage({ forwardId: forward.id })).toEqual(forward)
    expect(store.snapshot?.forwards).toEqual([forward])
  })
})

describe('历史分页并发', () => {
  it.each([false, true])('同一会话复用在途分页，实例：%s', async (instance) => {
    const { store, id } = createStore(instance)
    const response = deferred<SandboxMessageHistory>()
    callAction.mockReturnValue(response.promise)
    const first = store.loadEarlierMessages(id)
    const second = store.loadEarlierMessages(id)
    expect(second).toBe(first)
    expect(callAction).toHaveBeenCalledTimes(1)
    expect(callAction).toHaveBeenCalledWith('onebot-sandbox.message-history', {
      operatorId: '10003', conversationId: id, beforeMessageId: 'm3', limit: 50,
    })
    response.settle({ messages: [message('m1', id), message('m2', id)], forwards: [forward] })
    await Promise.all([first, second])
    expect(readConversationMessageIds(store.snapshot!, id)).toEqual(['m1', 'm2', 'm3'])
    expect(conversationMessagesOf(store.snapshot!, id).map(({ id }) => id)).toEqual(['m1', 'm2', 'm3'])
    expect(store.snapshot?.messages).toHaveLength(3)
    expect(store.snapshot?.forwards).toEqual([forward])
  })

  it('分页重叠时同时保持消息实体与会话引用唯一', async () => {
    const { store, id } = createStore()
    callAction.mockResolvedValue({ messages: [message('m1'), message('m3')], forwards: [] })
    await store.loadEarlierMessages(id)
    expect(readConversationMessageIds(store.snapshot!, id)).toEqual(['m1', 'm3'])
    expect(store.snapshot?.messages).toHaveLength(2)
  })

  it('失败后释放在途任务，下一次可以重试并从新边界继续分页', async () => {
    const { store, id } = createStore()
    callAction.mockRejectedValueOnce(new Error('连接中断'))
    await expect(store.loadEarlierMessages(id)).rejects.toThrow('连接中断')
    callAction.mockResolvedValueOnce({ messages: [message('m2')], nextBeforeMessageId: 'm2' })
    await store.loadEarlierMessages(id)
    callAction.mockResolvedValueOnce({ messages: [message('m1')] })
    await store.loadEarlierMessages(id)
    expect(callAction).toHaveBeenLastCalledWith('onebot-sandbox.message-history', {
      operatorId: '10003', conversationId: id, beforeMessageId: 'm2', limit: 50,
    })
    expect(readConversationMessageIds(store.snapshot!, id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('旧挂载的请求完成不会清掉新挂载的在途任务', async () => {
    const { store, id } = createStore()
    const oldResponse = deferred<SandboxMessageHistory>()
    const newResponse = deferred<SandboxMessageHistory>()
    callAction.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise)
    const old = store.loadEarlierMessages(id)
    store.dispose()
    store.activate()
    const current = store.loadEarlierMessages(id)
    expect(callAction).toHaveBeenCalledTimes(2)
    oldResponse.settle({ messages: [message('stale')] })
    await old
    expect(store.loadEarlierMessages(id)).toBe(current)
    newResponse.settle({ messages: [message('m1')] })
    await current
    expect(readConversationMessageIds(store.snapshot!, id)).toEqual(['m1', 'm3'])
  })

  it('读取途中会话被清空时不把历史重新写回', async () => {
    const { store, id } = createStore()
    const response = deferred<SandboxMessageHistory>()
    callAction.mockReturnValue(response.promise)
    const pending = store.loadEarlierMessages(id)
    store.seed(workspaceFor('10003', 2))
    const before = store.getView()
    response.settle({ messages: [message('m1')] })
    await pending
    expect(store.getView()).toBe(before)
    expect(store.snapshot?.messages).toEqual([])
  })
})
