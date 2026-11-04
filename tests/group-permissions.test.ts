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

describe('模拟 QQ 环境群权限操作', () => {
  it('用户申请入群，群主审批后建立成员关系和群会话', async () => {
    const { control } = await createControl()
    control.createUser({ id: '10005', name: '新申请用户' })

    const result = await control.performGroupAction({
      action: 'request-join',
      operatorId: '10005',
      groupId: '30001',
      comment: '申请加入测试群',
    })
    if (!result.requestId) throw new Error('入群申请未创建')

    await control.performGroupAction({
      action: 'handle-request',
      operatorId: '10001',
      requestId: result.requestId,
      approve: true,
    })

    const snapshot = control.getSnapshot()
    expect(snapshot.groups[0].members).toContainEqual({ participantId: '10005', role: 'member' })
    expect(snapshot.conversations).toContainEqual(expect.objectContaining({ id: 'group:30001' }))
  })

  it('邀请机器人入群必须由机器人通过 OneBot action 处理', async () => {
    const { control } = await createControl()
    control.createBot({ id: '20002', name: '受邀机器人', implementation: 'llbot', enabled: true })

    const result = await control.performGroupAction({
      action: 'invite',
      operatorId: '10002',
      groupId: '30001',
      targetId: '20002',
    })
    if (!result.requestId) throw new Error('群邀请未创建')

    await expect(control.performGroupAction({
      action: 'handle-request',
      operatorId: '10002',
      requestId: result.requestId,
      approve: true,
    })).rejects.toThrow('机器人邀请必须由机器人处理')

    const bot = control.getRuntimeBot('20002')
    await bot.internal.set_group_add_request({ flag: result.requestId, sub_type: 'invite', approve: true })
    expect(control.getSnapshot().groups[0].members).toContainEqual({ participantId: '20002', role: 'member' })
  })

  it('群管理员机器人可以通过 OneBot action 审批用户入群申请', async () => {
    const { control } = await createControl()
    control.createUser({ id: '10006', name: '机器人审批用户' })
    const request = await control.performGroupAction({ action: 'request-join', operatorId: '10006', groupId: '30001' })
    if (!request.requestId) throw new Error('入群申请未创建')

    await control.bot.internal.set_group_add_request({ flag: request.requestId, sub_type: 'add', approve: true })

    expect(control.getSnapshot().groups[0].members).toContainEqual({ participantId: '10006', role: 'member' })
  })

  it('成员可以退群，管理员只能踢普通成员，群主可以设置管理员', async () => {
    const { control } = await createControl()

    await expect(control.performGroupAction({ action: 'kick', operatorId: '10003', groupId: '30001', targetId: '10002' }))
      .rejects.toThrow('只有群主或管理员可以踢出成员')
    await expect(control.performGroupAction({ action: 'kick', operatorId: '10002', groupId: '30001', targetId: '10001' }))
      .rejects.toThrow('管理员不能管理群主或其他管理员')

    await control.performGroupAction({ action: 'set-admin', operatorId: '10001', groupId: '30001', targetId: '10003', enabled: true })
    expect(control.getSnapshot().groups[0].members.find(({ participantId }) => participantId === '10003')?.role).toBe('admin')

    await control.performGroupAction({ action: 'set-admin', operatorId: '10001', groupId: '30001', targetId: '10003', enabled: false })
    await control.performGroupAction({ action: 'leave', operatorId: '10003', groupId: '30001' })
    expect(control.getSnapshot().groups[0].members.some(({ participantId }) => participantId === '10003')).toBe(false)
  })

  it('成员修改自己的群名片，管理员修改成员名片和群名称', async () => {
    const { control } = await createControl()

    await control.performGroupAction({ action: 'set-card', operatorId: '10003', groupId: '30001', targetId: '10003', card: '新群名片' })
    await control.performGroupAction({ action: 'set-card', operatorId: '10002', groupId: '30001', targetId: '10003', card: '管理员设置' })
    await control.performGroupAction({ action: 'set-name', operatorId: '10002', groupId: '30001', name: '新的测试群' })

    const group = control.getSnapshot().groups[0]
    expect(group.name).toBe('新的测试群')
    expect(group.members.find(({ participantId }) => participantId === '10003')?.card).toBe('管理员设置')
  })

  it('用户和机器人群主都可以把群主身份转让给其他成员', async () => {
    const { control } = await createControl()

    await control.performGroupAction({ action: 'transfer-owner', operatorId: '10001', groupId: '30001', targetId: '20001' })
    expect(control.getSnapshot().groups[0].members).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: '10001', role: 'member' }),
      expect.objectContaining({ participantId: '20001', role: 'owner' }),
    ]))
    await expect(control.performGroupAction({ action: 'transfer-owner', operatorId: '10002', groupId: '30001', targetId: '10003' }))
      .rejects.toThrow('只有群主可以转让群主身份')

    await control.performGroupAction({ action: 'transfer-owner', operatorId: '20001', groupId: '30001', targetId: '10002' })
    expect(control.getSnapshot().groups[0].members).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: '20001', role: 'member' }),
      expect.objectContaining({ participantId: '10002', role: 'owner' }),
    ]))

    await control.performGroupAction({ action: 'kick', operatorId: '10002', groupId: '30001', targetId: '10003' })
    expect(control.getSnapshot().groups[0].members.some(({ participantId }) => participantId === '10003')).toBe(false)
  })

  it('机器人接任群主后可以作为 WebQQ 当前操作者管理群成员', async () => {
    const { control } = await createControl()

    await control.performGroupAction({ action: 'transfer-owner', operatorId: '10001', groupId: '30001', targetId: '20001' })
    const group = control.getSnapshot().groups[0]
    control.updateGroup({ id: group.id, name: group.name, members: group.members })
    await control.performGroupAction({ action: 'kick', operatorId: '20001', groupId: '30001', targetId: '10003' })

    expect(control.getSnapshot().groups[0].members.some(({ participantId }) => participantId === '10003')).toBe(false)
  })

  it('群内戳一戳写入事件消息并向群内机器人派发通知', async () => {
    const { app, control } = await createControl()
    const notices: Array<{ sessionSubtype?: string; channelId?: string; sessionTargetId?: string; noticeType?: string; subType?: string; groupId?: number; userId?: number; targetId?: number }> = []
    ;(app.on as unknown as (name: string, listener: (session: unknown) => void) => void)('notice', (session) => {
      const value = session as { subtype?: string; channelId?: string; targetId?: string; onebot?: Record<string, unknown> }
      notices.push({
        sessionSubtype: value.subtype,
        channelId: value.channelId,
        sessionTargetId: value.targetId,
        noticeType: value.onebot?.notice_type as string | undefined,
        subType: value.onebot?.sub_type as string | undefined,
        groupId: value.onebot?.group_id as number | undefined,
        userId: value.onebot?.user_id as number | undefined,
        targetId: value.onebot?.target_id as number | undefined,
      })
    })

    await control.performGroupAction({
      action: 'poke',
      operatorId: '10003',
      groupId: '30001',
      targetId: '10001',
      conversationId: 'group:30001',
    })

    const pokeMessage = control.getSnapshot().messages.find(({ event }) => event?.type === 'poke')
    expect(pokeMessage).toEqual(expect.objectContaining({
      authorId: '10003',
      conversationId: 'group:30001',
      content: '测试用户3 戳了戳 测试用户1',
      event: { type: 'poke', targetId: '10001' },
    }))
    expect(pokeMessage).not.toHaveProperty('botId')
    expect(notices).toContainEqual({
      // 与 adapter-onebot 对齐：群戳一戳会话需要 subtype=poke、targetId 与群会话 channelId。
      sessionSubtype: 'poke',
      channelId: 'group:30001',
      sessionTargetId: '10001',
      noticeType: 'notify',
      subType: 'poke',
      groupId: 30001,
      userId: 10003,
      targetId: 10001,
    })
  })

  it('角色、群资料和成员变更产生对应 OneBot 群通知', async () => {
    const { app, control } = await createControl()
    const notices: Array<Record<string, unknown>> = []
    ;(app.on as unknown as (name: string, listener: (session: unknown) => void) => void)('notice', (session) => {
      const value = session as { onebot?: Record<string, unknown> }
      notices.push(value.onebot ?? {})
    })

    await control.performGroupAction({ action: 'set-admin', operatorId: '10001', groupId: '30001', targetId: '10003', enabled: true })
    await control.performGroupAction({ action: 'set-admin', operatorId: '10001', groupId: '30001', targetId: '10003', enabled: false })
    await control.performGroupAction({ action: 'set-card', operatorId: '10002', groupId: '30001', targetId: '10003', card: '新名片' })
    await control.performGroupAction({ action: 'set-name', operatorId: '10002', groupId: '30001', name: '新群名称' })
    await control.performGroupAction({ action: 'kick', operatorId: '10002', groupId: '30001', targetId: '10003' })

    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ notice_type: 'group_admin', sub_type: 'set', group_id: 30001, user_id: 10003 }),
      expect.objectContaining({ notice_type: 'group_admin', sub_type: 'unset', group_id: 30001, user_id: 10003 }),
      expect.objectContaining({ notice_type: 'group_card', group_id: 30001, user_id: 10003, card_new: '新名片' }),
      expect.objectContaining({ notice_type: 'group_name', group_id: 30001, name_new: '新群名称' }),
      expect.objectContaining({ notice_type: 'group_decrease', sub_type: 'kick', group_id: 30001, user_id: 10003 }),
    ]))
  })

  it('踢出机器人时目标机器人收到 kick_me，其他机器人收到 kick', async () => {
    const { app, control } = await createControl()
    control.createBot({ id: '20002', name: '待踢机器人', implementation: 'llbot', enabled: true })
    const group = control.getSnapshot().groups[0]
    control.updateGroup({
      id: group.id,
      name: group.name,
      members: [...group.members, { participantId: '20002', role: 'member' }],
    })
    const notices: Array<Record<string, unknown>> = []
    ;(app.on as unknown as (name: string, listener: (session: unknown) => void) => void)('notice', (session) => {
      const value = session as { onebot?: Record<string, unknown> }
      if (value.onebot?.notice_type === 'group_decrease') notices.push(value.onebot)
    })

    await control.performGroupAction({ action: 'kick', operatorId: '10001', groupId: '30001', targetId: '20002' })

    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ self_id: 20001, sub_type: 'kick', user_id: 20002 }),
      expect.objectContaining({ self_id: 20002, sub_type: 'kick_me', user_id: 20002 }),
    ]))
  })

  it('成员被踢后失去群聊访问，重新入群恢复同一会话历史', async () => {
    const { control } = await createControl()
    const group = control.getSnapshot().groups[0]
    const result = await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '保留的群聊历史' })
    const message = control.getSnapshot().messages.find(({ id }) => id === result.messageId)
    if (!message) throw new Error('群聊消息未保存')

    await control.performGroupAction({ action: 'kick', operatorId: '10001', groupId: group.id, targetId: '10003' })

    expect(control.getSnapshot().conversations
      .filter(({ groupId }) => groupId === group.id)
      .map(({ id }) => id)).toEqual(['group:30001'])
    expect(control.getSnapshot().conversations.find(({ id }) => id === 'group:30001')?.messageIds).toEqual([message.id])
    expect(control.getVisibleSnapshot('10001').conversations).toContainEqual(expect.objectContaining({ groupId: '30001' }))
    expect(control.getVisibleSnapshot('10003').conversations).not.toContainEqual(expect.objectContaining({ groupId: '30001' }))
    expect(() => control.getMessageHistory({ operatorId: '10003', conversationId: 'group:30001' })).toThrow('会话不存在')
    await expect(control.sendMessage({ operatorId: '10003', conversationId: 'group:30001', content: '被踢后发送' }))
      .rejects.toThrow('会话不存在')

    const request = await control.performGroupAction({ action: 'request-join', operatorId: '10003', groupId: group.id })
    if (!request.requestId) throw new Error('重新入群申请未创建')
    await control.performGroupAction({ action: 'handle-request', operatorId: '10001', requestId: request.requestId, approve: true })

    expect(control.getVisibleSnapshot('10003').conversations).toContainEqual(expect.objectContaining({ id: 'group:30001' }))
    expect(control.getMessageHistory({ operatorId: '10003', conversationId: 'group:30001' }).messages)
      .toEqual([expect.objectContaining({ id: message.id, content: '保留的群聊历史' })])
    expect(control.getSnapshot().conversations.filter(({ id }) => id === 'group:30001')).toHaveLength(1)
  })
})
