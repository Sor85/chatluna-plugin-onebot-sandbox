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
  return { app, control }
}

describe('消息单份存储与机器人事件投递', () => {
  it('用户私聊机器人时只保存一份消息，并向对端机器人投递同一个消息 ID', async () => {
    const { control } = await createControl()

    const result = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '私聊消息',
    })

    const messages = control.getSnapshot().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual(expect.objectContaining({
      id: result.messageId,
      authorId: '10001',
      conversationId: 'private:10001:20001',
    }))
    expect(messages[0]).not.toHaveProperty('botId')
    expect(control.getBotDeliveries()).toEqual([
      expect.objectContaining({
        recipientBotId: '20001',
        messageId: result.messageId,
        conversationId: 'private:10001:20001',
      }),
    ])
  })

  it('普通用户之间私聊不产生机器人事件投递', async () => {
    const { control } = await createControl()
    const request = await control.performFriendAction({ action: 'request', operatorId: '10001', targetId: '10002' })
    if (!request.requestId) throw new Error('好友申请未创建')
    await control.performFriendAction({
      action: 'handle-request',
      operatorId: '10002',
      requestId: request.requestId,
      approve: true,
    })

    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:10002',
      content: '用户私聊',
    })

    expect(control.getBotDeliveries()).toEqual([])
  })

  it('用户群消息向所有机器人成员投递，但消息历史只保存一份', async () => {
    const { control } = await createControl()
    control.createBot({ id: '20002', name: '第二机器人', implementation: 'llbot', enabled: true })
    const group = control.getSnapshot().groups[0]
    control.updateGroup({
      id: group.id,
      name: group.name,
      members: [...group.members, { participantId: '20002', role: 'admin' }],
    })

    const result = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      content: '群消息',
    })

    expect(control.getSnapshot().messages.filter(({ id }) => id === result.messageId)).toHaveLength(1)
    expect(control.getBotDeliveries()
      .filter(({ messageId }) => messageId === result.messageId)
      .map(({ recipientBotId }) => recipientBotId)
      .sort()).toEqual(['20001', '20002'])
  })

  it('机器人发送群消息时排除自己，并向其他机器人投递', async () => {
    const { control } = await createControl()
    control.createBot({ id: '20002', name: '第二机器人', implementation: 'llbot', enabled: true })
    const group = control.getSnapshot().groups[0]
    control.updateGroup({
      id: group.id,
      name: group.name,
      members: [...group.members, { participantId: '20002', role: 'admin' }],
    })

    const result = await control.sendMessage({
      operatorId: '20001',
      conversationId: 'group:30001',
      content: '机器人群消息',
    })

    expect(control.getSnapshot().messages.find(({ id }) => id === result.messageId)).toEqual(expect.objectContaining({
      authorId: '20001',
    }))
    expect(control.getBotDeliveries().filter(({ messageId }) => messageId === result.messageId))
      .toEqual([expect.objectContaining({ recipientBotId: '20002' })])
  })

  it('机器人撤回自己的消息后保留原文并进入生命周期状态', async () => {
    const { control } = await createControl()
    const result = await control.sendMessage({
      operatorId: '20001',
      conversationId: 'private:10001:20001',
      content: '待撤回消息',
    })

    await control.recallBotMessage('20001', result.messageId)

    const recalled = control.getSnapshot().messages.find(({ id }) => id === result.messageId)
    expect(recalled).toEqual(expect.objectContaining({
      content: '待撤回消息',
      lifecycle: expect.objectContaining({
        status: 'recalled',
        operatorId: '20001',
        recalledAt: expect.any(String),
      }),
    }))
    expect(recalled?.event).toBeUndefined()
    expect(control.getSnapshot().conversations.find(({ id }) => id === 'private:10001:20001')?.messageIds)
      .toContain(result.messageId)
  })

  it('机器人不能撤回私聊中用户发送的消息', async () => {
    const { control } = await createControl()
    const result = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '用户消息',
    })

    await expect(control.recallBotMessage('20001', result.messageId)).rejects.toThrow('只能撤回自己发送的消息')
  })
})
