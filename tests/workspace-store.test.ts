import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GetSandboxWorkspaceInput } from '../src/types'
import { visibleConversationsOf, WorkspaceStore } from '../client/workspace/store'
import { deferred } from './helpers/deferred'
import { workspaceFor } from './helpers/workspace'

const { callAction, storage } = vi.hoisted(() => ({
  callAction: vi.fn(),
  storage: new Map<string, unknown>(),
}))

// 只替换网络与浏览器存储边界，快照裁剪、选择恢复和会话过滤均使用实际实现。
vi.mock('@chatluna/ui-client/client', () => ({ callAction }))
vi.mock('@chatluna/ui-storage', () => ({
  readStored: (key: string) => storage.get(key),
  writeStored: (key: string, value: unknown) => storage.set(key, value),
}))

const selectionKey = 'chatluna.onebot-sandbox.selection.main'
const storedSelection = { currentOperatorId: '10003', activeConversationId: 'group:30001' }

function conversationIds(store: WorkspaceStore) {
  const { workspace, currentOperatorId } = store.getView()
  return workspace ? visibleConversationsOf(workspace.snapshot, currentOperatorId).map(({ id }) => id) : []
}

beforeEach(() => {
  callAction.mockReset()
  storage.clear()
  storage.set(selectionKey, storedSelection)
})

describe('WebQQ 工作区异步加载', () => {
  it('进入页面时的变更信号等待本地操作者恢复，不让默认视角覆盖私聊', async () => {
    const initial = deferred<void>()
    const refresh = deferred<void>()
    callAction.mockImplementation((_name: string, input: GetSandboxWorkspaceInput) => {
      const revision = callAction.mock.calls.length
      // 和服务端一样：省略 operatorId 返回默认用户的裁剪快照，而不是所有会话。
      const workspace = workspaceFor(input.operatorId, revision)
      return (revision === 1 ? initial : refresh).promise.then(() => workspace)
    })
    const store = new WorkspaceStore(undefined)
    const loading = store.load()
    store.notifySceneChanged()
    // 给刷新开始的机会，但保留首个请求不返回，模拟页面初始化期间收到信号。
    await new Promise((resolve) => setTimeout(resolve, 0))
    initial.settle()
    await loading
    await vi.waitFor(() => expect(callAction).toHaveBeenCalledTimes(2))
    refresh.settle()
    await vi.waitFor(() => expect(store.snapshot?.revision).toBe(2))

    expect(store.getView().currentOperatorId).toBe('10003')
    expect(conversationIds(store)).toEqual(['private:10003:20001', 'private:10003:20002', 'group:30001'])
    expect(callAction).toHaveBeenLastCalledWith('onebot-sandbox.workspace', { operatorId: '10003' })
    expect(storage.get(selectionKey)).toEqual(storedSelection)
  })

  it('StrictMode 重挂载复用未完成的加载，期间多个信号只合并为一次刷新', async () => {
    const initial = deferred<void>()
    callAction.mockImplementation((_name: string, input: GetSandboxWorkspaceInput) => {
      const workspace = workspaceFor(input.operatorId)
      return callAction.mock.calls.length === 1 ? initial.promise.then(() => workspace) : Promise.resolve(workspace)
    })
    const store = new WorkspaceStore(undefined)
    const loading = store.load()
    store.dispose()
    store.activate()
    const remount = store.load()
    store.notifySceneChanged()
    store.notifySceneChanged()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(callAction).toHaveBeenCalledTimes(1)

    initial.settle()
    await Promise.all([loading, remount])
    await vi.waitFor(() => expect(callAction).toHaveBeenCalledTimes(2))
    expect(conversationIds(store)).toHaveLength(3)
    expect(callAction).toHaveBeenLastCalledWith('onebot-sandbox.workspace', { operatorId: '10003' })
  })

  it('刷新中的旧操作者响应不能覆盖已经切换的新视角', async () => {
    callAction.mockResolvedValue(workspaceFor('10003'))
    const store = new WorkspaceStore(undefined)
    await store.load()
    const refresh = deferred<void>()
    callAction.mockImplementation((_name: string, input: GetSandboxWorkspaceInput) => {
      const workspace = workspaceFor(input.operatorId, 2)
      return input.operatorId === '10003' ? refresh.promise.then(() => workspace) : Promise.resolve(workspace)
    })
    store.notifySceneChanged()
    await vi.waitFor(() => expect(callAction).toHaveBeenCalledTimes(2))
    await store.selectOperator('10001')
    refresh.settle()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getView().currentOperatorId).toBe('10001')
    expect(conversationIds(store)).toEqual(['private:10001:20001', 'private:10001:20002', 'group:30001'])
  })

  it('切换操作者与其裁剪快照在同一次视图更新中提交', async () => {
    callAction.mockImplementation((_name: string, input: GetSandboxWorkspaceInput) => Promise.resolve(workspaceFor(input.operatorId)))
    const store = new WorkspaceStore(undefined)
    await store.load()
    const counts: number[] = []
    store.subscribe(() => counts.push(conversationIds(store).length))
    await store.selectOperator('10001')
    expect(counts).toEqual([3])
  })

  it('已删除的本地操作者回退后，待处理信号使用恢复后的默认视角', async () => {
    storage.set(selectionKey, { ...storedSelection, currentOperatorId: 'deleted' })
    callAction.mockImplementation((_name: string, input: GetSandboxWorkspaceInput) => input.operatorId === 'deleted'
      ? Promise.reject(new Error('参与者不存在'))
      : Promise.resolve(workspaceFor(input.operatorId)))
    const store = new WorkspaceStore('test-space')
    storage.set('chatluna.onebot-sandbox.selection.test-space', storage.get(selectionKey))
    const loading = store.load()
    store.notifySceneChanged()
    await loading
    await vi.waitFor(() => expect(callAction).toHaveBeenCalledTimes(3))
    expect(callAction).toHaveBeenLastCalledWith('onebot-sandbox.workspace', { operatorId: '10001', spaceId: 'test-space' })
    expect(store.getView().currentOperatorId).toBe('10001')
    expect(conversationIds(store)).toHaveLength(3)
  })

  it('加载失败后释放在途任务，后续重试可以恢复完整列表', async () => {
    callAction.mockRejectedValue(new Error('连接中断'))
    const store = new WorkspaceStore(undefined)
    const loading = store.load()
    store.notifySceneChanged()
    await loading
    expect(store.getView().loadError).toBe('连接中断')
    expect(callAction).toHaveBeenCalledTimes(2)

    callAction.mockResolvedValue(workspaceFor('10003'))
    await store.load()
    expect(store.getView().loadError).toBeUndefined()
    expect(conversationIds(store)).toHaveLength(3)
  })

  it('重新加载期间切换操作者，迟到的加载结果不恢复旧选择', async () => {
    callAction.mockResolvedValue(workspaceFor('10003'))
    const store = new WorkspaceStore(undefined)
    await store.load()
    const response = deferred<ReturnType<typeof workspaceFor>>()
    callAction.mockReturnValueOnce(response.promise)
    const loading = store.load()
    callAction.mockResolvedValue(workspaceFor('10001'))
    await store.selectOperator('10001')
    response.settle(workspaceFor('10003'))
    await loading
    expect(store.getView().currentOperatorId).toBe('10001')
    expect(conversationIds(store)).toEqual(['private:10001:20001', 'private:10001:20002', 'group:30001'])
  })

  it('刷新进行中收到的多个信号合并为下一次读取，不丢掉最新修订', async () => {
    callAction.mockResolvedValue(workspaceFor('10003'))
    const store = new WorkspaceStore(undefined)
    await store.load()
    const response = deferred<ReturnType<typeof workspaceFor>>()
    callAction.mockReturnValueOnce(response.promise).mockResolvedValue(workspaceFor('10003', 3))
    store.notifySceneChanged()
    await vi.waitFor(() => expect(callAction).toHaveBeenCalledTimes(2))
    store.notifySceneChanged()
    store.notifySceneChanged()
    response.settle(workspaceFor('10003', 2))
    await vi.waitFor(() => expect(store.snapshot?.revision).toBe(3))
    expect(callAction).toHaveBeenCalledTimes(3)
    expect(conversationIds(store)).toHaveLength(3)
  })

  it('卸载后返回的加载结果不写视图或覆盖浏览器选择', async () => {
    const response = deferred<ReturnType<typeof workspaceFor>>()
    callAction.mockReturnValue(response.promise)
    const store = new WorkspaceStore(undefined)
    const loading = store.load()
    store.notifySceneChanged()
    store.dispose()
    response.settle(workspaceFor('10003'))
    await loading
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getView().workspace).toBeUndefined()
    expect(storage.get(selectionKey)).toEqual(storedSelection)
    expect(callAction).toHaveBeenCalledTimes(1)
  })
})
