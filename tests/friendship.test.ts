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

describe('模拟 QQ 环境好友关系', () => {
  it('接收方切换身份审批后双方都能看到好友关系和私聊', async () => {
    const { control } = await createControl()

    const request = await control.performFriendAction({
      action: 'request',
      operatorId: '10001',
      targetId: '10003',
    })
    if (!request.requestId) throw new Error('好友申请未创建')

    await control.performFriendAction({ action: 'handle-request', operatorId: '10003', requestId: request.requestId, approve: true })

    for (const operatorId of ['10001', '10003']) {
      const snapshot = control.getVisibleSnapshot(operatorId)
      expect(snapshot.friendships.some(({ participantIds }) => participantIds.includes('10001') && participantIds.includes('10003'))).toBe(true)
      expect(snapshot.conversations).toContainEqual(expect.objectContaining({
        id: 'private:10001:10003',
        type: 'direct',
        participantIds: ['10001', '10003'],
      }))
    }
  })

  it('普通用户审批好友申请后可以设置本地备注并删除关系', async () => {
    const { control } = await createControl()

    const request = await control.performFriendAction({
      action: 'request',
      operatorId: '10001',
      targetId: '10002',
      comment: '一起测试',
    })
    if (!request.requestId) throw new Error('好友申请未创建')
    expect(control.getSnapshot().friendships.some(({ participantIds }) => participantIds.includes('10001') && participantIds.includes('10002'))).toBe(false)

    await control.performFriendAction({ action: 'handle-request', operatorId: '10002', requestId: request.requestId, approve: true })
    expect(control.getSnapshot().conversations.filter(({ type, id }) => type === 'direct' && id === 'private:10001:10002'))
      .toEqual([expect.objectContaining({ participantIds: ['10001', '10002'] })])
    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:10002',
      content: '普通好友私聊',
    })
    const directMessages = control.getSnapshot().messages.filter(({ content }) => content === '普通好友私聊')
    expect(directMessages.map(({ conversationId }) => conversationId)).toEqual(['private:10001:10002'])
    await control.performFriendAction({ action: 'set-remark', operatorId: '10001', targetId: '10002', remark: '测试搭档' })
    const friendship = control.getSnapshot().friendships.find(({ participantIds }) => participantIds.includes('10001') && participantIds.includes('10002'))
    expect(friendship?.remarks).toEqual({ '10001': '测试搭档' })
    expect(control.getSnapshot().participants.find(({ id }) => id === '10002')?.name).toBe('测试用户2')

    await control.performFriendAction({ action: 'delete', operatorId: '10001', targetId: '10002' })
    expect(control.getSnapshot().friendships.some(({ participantIds }) => participantIds.includes('10001') && participantIds.includes('10002'))).toBe(false)
    expect(control.getSnapshot().conversations.find(({ id }) => id === 'private:10001:10002')?.messageIds).toEqual([directMessages[0].id])
    expect(control.getVisibleSnapshot('10001').conversations.some(({ id }) => id === 'private:10001:10002')).toBe(false)
    expect(() => control.getMessageHistory({ operatorId: '10001', conversationId: 'private:10001:10002' })).toThrow('操作者 10001 与 10002 不是好友，私聊不可用')
    await expect(control.sendMessage({
      operatorId: '10002',
      conversationId: 'private:10001:10002',
      content: '关系删除后不可发送',
    })).rejects.toThrow('操作者 10002 与 10001 不是好友，私聊不可用')

    const restoreRequest = await control.performFriendAction({ action: 'request', operatorId: '10002', targetId: '10001' })
    if (!restoreRequest.requestId) throw new Error('恢复好友申请未创建')
    await control.performFriendAction({ action: 'handle-request', operatorId: '10001', requestId: restoreRequest.requestId, approve: true })
    expect(control.getMessageHistory({
      operatorId: '10002',
      conversationId: 'private:10001:10002',
    }).messages.map(({ content }) => content)).toEqual(['普通好友私聊'])
    expect(control.getSnapshot().conversations.filter(({ id }) => id === 'private:10001:10002')).toHaveLength(1)
  })

  it('机器人操作者可以主动申请好友、设置备注并删除关系', async () => {
    const { control } = await createControl()
    control.createUser({ id: '10004', name: '机器人目标用户' })
    await control.performFriendAction({ action: 'delete', operatorId: '20001', targetId: '10004' })

    const request = await control.performFriendAction({
      action: 'request',
      operatorId: '20001',
      targetId: '10004',
      comment: '机器人主动申请',
    })
    if (!request.requestId) throw new Error('机器人好友申请未创建')

    await control.performFriendAction({ action: 'handle-request', operatorId: '10004', requestId: request.requestId, approve: true })
    await control.performFriendAction({ action: 'set-remark', operatorId: '20001', targetId: '10004', remark: '机器人好友' })

    const friendship = control.getSnapshot().friendships.find(({ participantIds }) => participantIds.includes('20001') && participantIds.includes('10004'))
    expect(friendship?.remarks).toEqual({ '20001': '机器人好友' })
    expect(control.getVisibleSnapshot('20001').conversations).toContainEqual(expect.objectContaining({ id: 'private:10004:20001' }))

    await control.performFriendAction({ action: 'delete', operatorId: '20001', targetId: '10004' })
    expect(control.getSnapshot().friendships.some(({ id }) => id === friendship?.id)).toBe(false)
  })

  it('停用机器人保持可观察但不能执行好友操作', async () => {
    const { control } = await createControl()
    control.updateBot({ id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: false })

    await expect(control.performFriendAction({ action: 'delete', operatorId: '20001', targetId: '10001' }))
      .rejects.toThrow('机器人已停用：20001')
  })

  it('发给机器人的申请只能由 OneBot action 审批，并向机器人派发戳一戳和删除事件', async () => {
    const { app, control } = await createControl()
    control.createUser({ id: '10004', name: '申请用户' })
    await control.performFriendAction({ action: 'delete', operatorId: '10004', targetId: '20001' })
    const request = await control.performFriendAction({ action: 'request', operatorId: '10004', targetId: '20001' })
    if (!request.requestId) throw new Error('机器人好友申请未创建')
    const notices: Array<{ type?: string; subtype?: string; channelId?: string; sessionTargetId?: string; noticeType?: string; userId?: number; targetId?: number }> = []
    ;(app.on as unknown as (name: string, listener: (session: unknown) => void) => void)('notice', (session) => {
      const value = session as { type?: string; subtype?: string; channelId?: string; targetId?: string; onebot?: { notice_type?: string; user_id?: number; target_id?: number } }
      notices.push({
        type: value.type,
        subtype: value.subtype,
        channelId: value.channelId,
        sessionTargetId: value.targetId,
        noticeType: value.onebot?.notice_type,
        userId: value.onebot?.user_id,
        targetId: value.onebot?.target_id,
      })
    })

    await expect(control.performFriendAction({ action: 'handle-request', operatorId: '10004', requestId: request.requestId, approve: true }))
      .rejects.toThrow('机器人申请必须由机器人处理')

    await control.bot.internal.set_friend_add_request({ flag: request.requestId, approve: true, remark: '申请用户' })
    expect(control.getSnapshot().friendships.some(({ participantIds }) => participantIds.includes('10004') && participantIds.includes('20001'))).toBe(true)
    expect(control.getSnapshot().conversations.some(({ id }) => id === 'private:10004:20001')).toBe(true)

    await control.performFriendAction({ action: 'poke', operatorId: '10004', targetId: '20001' })
    const pokeMessage = control.getSnapshot().messages.find(({ event }) => event?.type === 'poke')
    expect(pokeMessage).toEqual(expect.objectContaining({
      authorId: '10004',
      conversationId: 'private:10004:20001',
      content: '申请用户 戳了戳 ChatLuna',
      event: { type: 'poke', targetId: '20001' },
    }))
    expect(pokeMessage).not.toHaveProperty('botId')
    await control.performFriendAction({ action: 'delete', operatorId: '10004', targetId: '20001' })
    expect(notices).toEqual([
      // 与 adapter-onebot 对齐：poke 需要 subtype/targetId/channelId，插件靠这些字段过滤戳一戳。
      {
        type: 'notice',
        subtype: 'poke',
        channelId: 'private:10004',
        sessionTargetId: '20001',
        noticeType: 'notify',
        userId: 10004,
        targetId: 20001,
      },
      {
        type: 'notice',
        subtype: undefined,
        channelId: 'private:10004',
        sessionTargetId: undefined,
        noticeType: 'friend_del',
        userId: 10004,
        targetId: 20001,
      },
    ])
  })

  it('无好友关系时拒绝互动且不产生部分状态', async () => {
    const { control } = await createControl()
    const before = control.getSnapshot()

    await expect(control.performFriendAction({ action: 'poke', operatorId: '10001', targetId: '10002' }))
      .rejects.toThrow('好友关系不存在')

    expect(control.getSnapshot()).toEqual(before)
  })

  it('双方已有待处理申请时拒绝反向重复申请', async () => {
    const { control } = await createControl()
    await control.performFriendAction({ action: 'request', operatorId: '10001', targetId: '10002' })
    const before = control.getSnapshot()

    await expect(control.performFriendAction({ action: 'request', operatorId: '10002', targetId: '10001' }))
      .rejects.toThrow('双方已有待处理的好友申请')

    expect(control.getSnapshot()).toEqual(before)
  })

  it('用户、机器人之间的私聊使用同一个稳定会话，机器人之间也可以互通', async () => {
    const { control } = await createControl()
    control.createBot({ id: '20002', name: '第二个机器人', implementation: 'llbot', enabled: true })

    const conversation = control.getSnapshot().conversations.filter(({ id }) => id === 'private:20001:20002')
    expect(conversation).toHaveLength(1)
    expect(control.getVisibleSnapshot('20001').conversations).toContainEqual(expect.objectContaining({ id: 'private:20001:20002' }))
    expect(control.getVisibleSnapshot('20002').conversations).toContainEqual(expect.objectContaining({ id: 'private:20001:20002' }))

    await control.sendMessage({ operatorId: '20001', conversationId: 'private:20001:20002', content: '机器人之间的测试消息' })
    expect(control.getMessageHistory({ operatorId: '20002', conversationId: 'private:20001:20002' }).messages)
      .toEqual([expect.objectContaining({ authorId: '20001', content: '机器人之间的测试消息' })])
  })

  it('群主可以同意入群申请并为申请人建立群会话', async () => {
    const { control } = await createControl()
    control.createUser({ id: '10004', name: '申请用户' })
    const request = await control.performGroupAction({ action: 'request-join', operatorId: '10004', groupId: '30001' })
    if (!request.requestId) throw new Error('入群申请未创建')

    await control.performFriendAction({ action: 'handle-request', operatorId: '10001', requestId: request.requestId, approve: true })

    const snapshot = control.getSnapshot()
    expect(snapshot.requests.some(({ id }) => id === request.requestId)).toBe(false)
    expect(snapshot.groups[0].members).toContainEqual({ participantId: '10004', role: 'member' })
    expect(snapshot.conversations.some(({ id }) => id === 'group:30001')).toBe(true)
  })

  it('普通群成员不能处理入群申请', async () => {
    const { control } = await createControl()
    control.createUser({ id: '10004', name: '申请用户' })
    const request = await control.performGroupAction({ action: 'request-join', operatorId: '10004', groupId: '30001' })
    if (!request.requestId) throw new Error('入群申请未创建')

    await expect(control.performFriendAction({ action: 'handle-request', operatorId: '10003', requestId: request.requestId, approve: true }))
      .rejects.toThrow('只有群主或管理员可以处理入群申请')
  })
})
