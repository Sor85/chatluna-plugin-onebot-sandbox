import { App } from './helpers/app'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmptyScene, SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { readConversationMessageIds } from '../src/conversation-resolution'
import { SandboxTestSpaceService, trimSnapshotMessages } from '../src/test-spaces'
import type { SandboxTestSpacePersistence, SandboxTestSpacePersistenceRecord } from '../src/persistence'

const apps: App[] = []
const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** 空间媒体目录派生自 ctx.baseDir；不隔离会把媒体写进仓库工作区。 */
function isolatedApp(): App {
  const app = new App()
  const baseDir = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-spaces-base-'))
  temporaryDirectories.push(baseDir)
  app.baseDir = baseDir
  apps.push(app)
  return app
}

function createServices() {
  const app = isolatedApp()
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const main = new SandboxControlService(app, { runtimeBots })
  const spaces = new SandboxTestSpaceService(app, runtimeBots)
  return { main, spaces }
}

describe('AI 测试空间', () => {
  it('创建空白隔离空间并按创建时间从旧到新列出', () => {
    const { main, spaces } = createServices()
    const first = spaces.createSpace({ name: '退群公告测试' })
    const second = spaces.createSpace({ name: '好友申请测试' })

    expect(first.snapshot).toEqual(createEmptyScene())
    expect(spaces.listSpaces().map(({ id }) => id)).toEqual([first.id, second.id])
    expect(main.getSnapshot().participants).toHaveLength(4)

    first.control.createUser({ id: '11001', name: '测试成员' })
    expect(first.control.getSnapshot().participants.map(({ id }) => id)).toEqual(['11001'])
    expect(second.control.getSnapshot().participants).toEqual([])
    expect(main.getSnapshot().participants).toHaveLength(4)
  })

  it('用户接管时暂停 AI 修改，归还后恢复', () => {
    const { spaces } = createServices()
    const space = spaces.createSpace({})

    expect(spaces.requireAiControl(space.id)).toBe(space.control)
    spaces.takeOver(space.id)
    expect(() => spaces.requireAiControl(space.id)).toThrow('空间已由用户接管')
    expect(spaces.requireReadable(space.id)).toBe(space.control)
    expect(spaces.requireUserControl(space.id)).toBe(space.control)
    spaces.returnControl(space.id)
    expect(spaces.requireAiControl(space.id)).toBe(space.control)
  })

  it('占用状态随创建、接管和结束切换', () => {
    const { spaces } = createServices()
    const events: boolean[] = []
    spaces.onOccupationChange(() => events.push(spaces.isOccupied()))
    expect(spaces.isOccupied()).toBe(false)

    const space = spaces.createSpace({})
    expect(spaces.isOccupied()).toBe(true)
    spaces.takeOver(space.id)
    expect(spaces.isOccupied()).toBe(false)
    spaces.returnControl(space.id)
    expect(spaces.isOccupied()).toBe(true)
    spaces.terminateSpace(space.id)
    expect(spaces.isOccupied()).toBe(false)
    expect(events).toEqual([true, false, true, false])
  })

  it('用户终止任务后空间结束为已完成，AI 不能再修改', () => {
    const { spaces } = createServices()
    const space = spaces.createSpace({})

    expect(spaces.terminateSpace(space.id).status).toBe('completed')
    expect(spaces.getSpace(space.id).completedAt).toBeTruthy()
    expect(() => spaces.requireAiControl(space.id)).toThrow('空间当前不可修改：completed')
    expect(() => spaces.terminateSpace(space.id)).toThrow('空间已结束')
  })

  it('AI 重新激活后恢复 AI 控制，用户重新激活后保持接管', () => {
    const { spaces } = createServices()
    const aiSpace = spaces.createSpace({})
    spaces.completeSpace(aiSpace.id)
    expect(spaces.reactivateSpace(aiSpace.id, 'running').status).toBe('running')
    expect(spaces.requireAiControl(aiSpace.id)).toBe(aiSpace.control)

    spaces.completeSpace(aiSpace.id)
    expect(spaces.reactivateSpace(aiSpace.id).status).toBe('taken-over')
    expect(spaces.requireUserControl(aiSpace.id)).toBe(aiSpace.control)
  })

  it('用户接管后 AI 不能将空间标记为失败', () => {
    const { spaces } = createServices()
    const space = spaces.createSpace({})
    spaces.takeOver(space.id)

    expect(() => spaces.failSpace(space.id)).toThrow('空间已由用户接管')
  })

  it('完成后保留场景并停止机器人，重新激活时检查全局机器人 ID', () => {
    const { spaces } = createServices()
    const first = spaces.createSpace({})
    first.control.createBot({ id: '21001', name: '测试机器人', implementation: 'napcat', enabled: true })

    spaces.completeSpace(first.id)
    expect(spaces.getSpace(first.id).status).toBe('completed')
    expect(spaces.getSpace(first.id).snapshot.participants.map(({ id }) => id)).toEqual(['21001'])

    const second = spaces.createSpace({})
    second.control.createBot({ id: '21001', name: '占用 ID 的机器人', implementation: 'llbot', enabled: true })
    expect(() => spaces.reactivateSpace(first.id)).toThrow('机器人 ID 已被活动场景占用：21001')
  })

  it('数据库模式下恢复空间元数据和独立场景', async () => {
    const records = new Map<string, SandboxTestSpacePersistenceRecord>()
    const persistence: SandboxTestSpacePersistence = {
      loadAll: async () => [...records.values()].map((record) => structuredClone(record)),
      save: async (record) => { records.set(record.id, structuredClone(record)) },
      delete: async (id) => { records.delete(id) },
    }
    const firstApp = isolatedApp()
    const firstSpaces = new SandboxTestSpaceService(firstApp, new SandboxRuntimeBotRegistry(), persistence)
    const created = firstSpaces.createSpace({ name: '持久化测试' })
    created.control.createUser({ id: '11001', name: '测试成员' })
    firstSpaces.completeSpace(created.id)
    await firstSpaces.waitForPersistence()

    const secondApp = isolatedApp()
    const restoredSpaces = new SandboxTestSpaceService(secondApp, new SandboxRuntimeBotRegistry(), persistence)
    await secondApp.start()

    expect(restoredSpaces.getSpace(created.id)).toMatchObject({
      name: '持久化测试',
      status: 'completed',
    })
    expect(restoredSpaces.getSpace(created.id).snapshot.participants).toEqual([
      expect.objectContaining({ id: '11001', name: '测试成员' }),
    ])
  })

  it('trimSnapshotMessages 按会话保留末尾消息并标记更多消息', () => {
    const messages = ['m1', 'm2', 'm3', 'm4', 'm5']
    const snapshot = {
      ...createEmptyScene(),
      conversations: [{
        id: 'private:11001:11002',
        type: 'direct' as const,
        participantIds: ['11001', '11002'] as [string, string],
        messageIds: [...messages],
      }],
      messages: messages.map((id) => ({ id, authorId: '11001', conversationId: 'private:11001:11002', content: `内容 ${id}`, createdAt: '2026-01-01T00:00:00.000Z' })),
    }

    const trimmed = trimSnapshotMessages(snapshot, 2)
    expect(trimmed.conversations[0].messageIds).toEqual(['m4', 'm5'])
    expect(trimmed.conversations[0].hasMoreMessages).toBe(true)
    expect(trimmed.messages.map(({ id }) => id)).toEqual(['m4', 'm5'])

    const untrimmed = trimSnapshotMessages(snapshot, 10)
    expect(untrimmed.conversations[0].messageIds).toHaveLength(5)
    expect(untrimmed.conversations[0].hasMoreMessages).toBe(false)
  })

  it('trimSnapshotMessages 把分支的继承前缀物化进实例行并去掉分叉点', () => {
    const messages = ['m1', 'm2', 'm3']
    const snapshot = {
      ...createEmptyScene(),
      conversations: [{
        id: 'private:11001:11002',
        type: 'direct' as const,
        participantIds: ['11001', '11002'] as [string, string],
        messageIds: [...messages],
      }],
      conversationInstances: [{
        id: 'instance-1',
        rootConversationId: 'private:11001:11002',
        title: '换一种问法',
        forkPoint: { conversationId: 'private:11001:11002', messageId: 'm2' },
        messageIds: ['x1'],
      }],
      messages: [...messages, 'x1'].map((id) => ({
        id,
        authorId: '11001',
        conversationId: id === 'x1' ? 'instance-1' : 'private:11001:11002',
        content: `内容 ${id}`,
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
    }

    const trimmed = trimSnapshotMessages(snapshot, 10)

    // 消费端拿到的是「这个会话现在由哪些消息组成」，来源链只在权威场景里展开。
    expect(trimmed.conversationInstances).toEqual([{
      id: 'instance-1',
      rootConversationId: 'private:11001:11002',
      title: '换一种问法',
      messageIds: ['m1', 'm2', 'x1'],
      hasMoreMessages: false,
    }])
    expect(readConversationMessageIds(trimmed, 'instance-1')).toEqual(['m1', 'm2', 'x1'])
  })
})
