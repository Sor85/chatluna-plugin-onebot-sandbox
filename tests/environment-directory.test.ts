import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

async function createControl() {
  const app = new App()
  let control: SandboxControlService | undefined
  let middlewareCalls = 0
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx)
  })
  app.middleware(() => {
    middlewareCalls += 1
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  return { control, getMiddlewareCalls: () => middlewareCalls }
}

describe('模拟 QQ 环境目录管理', () => {
  it('静默创建、编辑和删除普通用户并清理关联会话', async () => {
    const { control, getMiddlewareCalls } = await createControl()
    const initialRevision = control.getSnapshot().revision

    control.createUser({ id: '10099', name: '新用户' })
    const created = control.getSnapshot()
    expect(created.revision).toBe(initialRevision + 1)
    expect(created.participants).toContainEqual(expect.objectContaining({
      kind: 'user',
      id: '10099',
      name: '新用户',
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
    }))
    expect(created.conversations).toContainEqual({
      id: 'private:10099:20001',
      type: 'direct',
      participantIds: ['10099', '20001'],
      messageIds: [],
    })

    control.updateUser({ id: '10099', name: '更新用户' })
    expect(control.getSnapshot().participants.find(({ id }) => id === '10099')).toEqual(expect.objectContaining({
      kind: 'user',
      id: '10099',
      name: '更新用户',
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
    }))

    control.deleteUser({ id: '10099' })
    const snapshot = control.getSnapshot()
    expect(snapshot.revision).toBe(initialRevision + 3)
    expect(snapshot.participants.some(({ id }) => id === '10099')).toBe(false)
    expect(snapshot.conversations.some((conversation) => conversation.type === 'direct' && conversation.participantIds.includes('10099'))).toBe(false)
    expect(snapshot.messages).toEqual([])
    expect(getMiddlewareCalls()).toBe(0)
  })

  it('静默管理可独立选择实现配置的虚拟 OneBot 机器人', async () => {
    const { control, getMiddlewareCalls } = await createControl()

    control.createBot({
      id: '20099',
      name: 'LLBot 测试机器人',
      implementation: 'llbot',
      enabled: false,
    })
    const created = control.getSnapshot()
    expect(created.participants).toContainEqual(expect.objectContaining({
      kind: 'bot',
      id: '20099',
      name: 'LLBot 测试机器人',
      implementation: 'llbot',
      enabled: false,
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
    }))
    expect(created.conversations.filter((conversation) => conversation.type === 'direct' && conversation.participantIds.includes('20099')))
      .toHaveLength(created.participants.length - 1)

    control.updateBot({
      id: '20099',
      name: 'NapCat 测试机器人',
      implementation: 'napcat',
      enabled: true,
    })
    expect(control.getSnapshot().participants.find(({ id }) => id === '20099')).toEqual(expect.objectContaining({
      kind: 'bot',
      id: '20099',
      name: 'NapCat 测试机器人',
      implementation: 'napcat',
      enabled: true,
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
    }))

    control.deleteBot({ id: '20099' })
    const removed = control.getSnapshot()
    expect(removed.participants.some(({ id }) => id === '20099')).toBe(false)
    expect(removed.conversations.some((conversation) => conversation.type === 'direct' && conversation.participantIds.includes('20099'))).toBe(false)
    expect(removed.groups.some(({ members }) => members.some(({ participantId }) => participantId === '20099'))).toBe(false)
    expect(getMiddlewareCalls()).toBe(0)
  })

  it('静默创建、编辑和删除群组及初始成员关系', async () => {
    const { control, getMiddlewareCalls } = await createControl()

    control.createGroup({
      id: '30099',
      name: '新增测试群',
      members: [
        { participantId: '10001', card: '新群主', role: 'owner' },
        { participantId: '20001', card: '测试机器人', role: 'member' },
      ],
    })
    expect(control.getSnapshot().conversations).toContainEqual({
      id: 'group:30099',
      type: 'group',
      groupId: '30099',
      messageIds: [],
    })

    control.updateGroup({
      id: '30099',
      name: '更新测试群',
      members: [
        { participantId: '10001', card: '新群主', role: 'owner' },
        { participantId: '10002', card: '协作管理员', role: 'admin' },
        { participantId: '20001', card: '测试机器人', role: 'member' },
      ],
    })
    const updated = control.getSnapshot()
    expect(updated.groups.find(({ id }) => id === '30099')).toMatchObject({
      name: '更新测试群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '10002', role: 'admin' },
        { participantId: '20001', role: 'member' },
      ],
    })
    expect(updated.conversations.filter(({ id }) => id === 'group:30099')).toHaveLength(1)

    control.deleteGroup({ id: '30099' })
    const removed = control.getSnapshot()
    expect(removed.groups.some(({ id }) => id === '30099')).toBe(false)
    expect(removed.conversations.some(({ groupId }) => groupId === '30099')).toBe(false)
    expect(getMiddlewareCalls()).toBe(0)
  })

  it('允许机器人作为群主并在删除机器人时清理其群组', async () => {
    const { control } = await createControl()

    control.createGroup({
      id: '30099',
      name: '机器人群主测试群',
      members: [
        { participantId: '20001', card: 'Koishi', role: 'owner' },
        { participantId: '10001', card: '测试用户1', role: 'member' },
      ],
    })
    expect(control.getSnapshot().groups.find(({ id }) => id === '30099')?.members[0]).toMatchObject({
      participantId: '20001',
      role: 'owner',
    })

    control.deleteBot({ id: '20001' })

    expect(control.getSnapshot().groups.some(({ id }) => id === '30099')).toBe(false)
    expect(control.getSnapshot().conversations.some(({ groupId }) => groupId === '30099')).toBe(false)
  })

})
