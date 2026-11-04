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
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx)
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  return control
}

describe('统一参与者默认场景', () => {
  it('提供可直接验证消息、申请与群权限的单份逻辑场景', async () => {
    const control = await createControl()
    const snapshot = control.getSnapshot()

    expect(snapshot.participants).toEqual([
      expect.objectContaining({ kind: 'user', id: '10001', name: '测试用户1' }),
      expect.objectContaining({ kind: 'user', id: '10002', name: '测试用户2' }),
      expect.objectContaining({ kind: 'user', id: '10003', name: '测试用户3' }),
      expect.objectContaining({ kind: 'bot', id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: true }),
    ])
    expect(snapshot.groups).toEqual([expect.objectContaining({
      id: '30001',
      name: '测试群',
      members: expect.arrayContaining([
        expect.objectContaining({ participantId: '10001', role: 'owner' }),
        expect.objectContaining({ participantId: '10002', role: 'admin' }),
        expect.objectContaining({ participantId: '10003', role: 'member' }),
        expect.objectContaining({ participantId: '20001', role: 'admin' }),
      ]),
    })])
    expect(snapshot.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'private:10001:20001', participantIds: ['10001', '20001'] }),
      expect.objectContaining({ id: 'private:10002:20001', participantIds: ['10002', '20001'] }),
      expect.objectContaining({ id: 'private:10003:20001', participantIds: ['10003', '20001'] }),
      expect.objectContaining({ id: 'group:30001', groupId: '30001' }),
    ]))
    expect(snapshot.conversations).toHaveLength(4)
    expect(snapshot.conversations.every((conversation) => !('userId' in conversation) && !('botId' in conversation))).toBe(true)

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '默认场景消息' })
    const request = await control.performFriendAction({ action: 'request', operatorId: '10001', targetId: '10002' })
    expect(request.requestId).toBeDefined()
    expect(control.getSnapshot().messages[0]).toEqual(expect.objectContaining({
      authorId: '10001',
      conversationId: 'private:10001:20001',
      content: '默认场景消息',
    }))
    expect(control.getSnapshot().messages[0]).not.toHaveProperty('botId')
  })
})
