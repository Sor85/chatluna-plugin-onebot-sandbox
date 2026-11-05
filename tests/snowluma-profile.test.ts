import { App } from './helpers/app'
import type { Session } from '@satorijs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { getOneBotMessageId, getOneBotMessageSequence, getOneBotProfileBaseline } from '../src/onebot-profiles'

/**
 * SnowLuma 实现配置：action 名称、参数与返回形状按 SnowLuma 上游（e44e4ced）出现，
 * 不沿用 NapCat 或 LLBot 的写法。
 */

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

/** 新建 SnowLuma 机器人 20002，并作为管理员放进默认测试群 30001。 */
async function createSnowLuma(control: SandboxControlService) {
  control.createBot({ id: '20002', name: 'SnowLuma 机器人', implementation: 'snowluma', enabled: true })
  const group = control.getSnapshot().groups.find(({ id }) => id === '30001')!
  control.updateGroup({
    id: group.id,
    name: group.name,
    members: [...group.members, { participantId: '20002', role: 'admin' }],
  })
  return control.getRuntimeBot('20002')
}

type Request = (action: string, params?: Record<string, unknown>) => Promise<unknown>

function requester(bot: { internal: { _request(action: string, params: Record<string, unknown>): Promise<unknown> } }): Request {
  return async (action, params = {}) => (await bot.internal._request(action, params) as { data: unknown }).data
}

describe('SnowLuma 实现配置', () => {
  it('维护带快照日期和来源版本的能力基线，只声明上游注册的 action 名', () => {
    const baseline = getOneBotProfileBaseline('snowluma')
    expect(baseline).toMatchObject({
      id: 'snowluma',
      label: 'SnowLuma',
      snapshotDate: '2026-11-03',
      sourceRevision: 'e44e4ced17c5911b9aa9db449ba29f2d9e567d2a',
      appName: 'SnowLuma',
    })
    const actions = baseline.capabilities.flatMap(({ action, aliases }) => [action, ...aliases ?? []])
    expect(actions).toEqual(expect.arrayContaining([
      'get_version_info', 'send_forward_msg', 'send_group_forward_msg', 'friend_poke', 'group_poke',
      '_get_group_notice', '_del_group_notice', 'set_group_kick_members', 'get_recent_contact',
    ]))
    for (const missing of ['getGroupShutList', '_delete_group_notice', 'batch_delete_group_member', 'get_flash_file_info']) {
      expect(actions).not.toContain(missing)
    }
    // 同 id 的覆盖原位替换共享条目，不会出现两条同 id 的能力。
    const ids = baseline.capabilities.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(baseline.capabilities.find(({ id }) => id === 'message.emoji-like.list')!.description).toContain('不分页')
  })

  it('版本、状态与好友列表按 SnowLuma 形状返回', async () => {
    const control = await createControl()
    const request = requester(await createSnowLuma(control))

    await expect(request('get_version_info')).resolves.toEqual({ app_name: 'SnowLuma', app_version: expect.any(String), protocol_version: 'v11' })
    await expect(request('get_status')).resolves.toEqual({ online: true, good: true, time: expect.any(Number) })
    const friends = await request('get_friend_list') as Array<Record<string, unknown>>
    expect(friends.length).toBeGreaterThan(0)
    for (const friend of friends) expect(friend).toMatchObject({ category_id: 0, remark: expect.any(String) })
    const [category] = await request('get_friends_with_category') as Array<Record<string, unknown>>
    expect(category).toMatchObject({ categoryId: 0, categoryMbCount: friends.length })
    expect(category).not.toHaveProperty('categorySortId')
    expect(category).not.toHaveProperty('onlineCount')
    await expect(request('get_recent_contact', { count: 10 })).resolves.toEqual([])
    await expect(control.getRuntimeBot('20002').internal._request('getGroupShutList', { group_id: 30001 }))
      .rejects.toThrow('SnowLuma 基线不支持 OneBot action：getGroupShutList')
  })

  it('禁言列表、群公告与批量踢人使用 SnowLuma 的字段名', async () => {
    const control = await createControl()
    control.createUser({ id: '10004', name: '待移除成员' })
    const bot = await createSnowLuma(control)
    const group = control.getSnapshot().groups[0]
    control.updateGroup({ id: group.id, name: group.name, members: [...group.members, { participantId: '10004', role: 'member' }] })
    const request = requester(bot)

    await request('set_group_ban', { group_id: 30001, user_id: 10003, duration: 300 })
    const [muted] = await request('get_group_shut_list', { group_id: 30001 }) as Array<Record<string, unknown>>
    expect(muted).toEqual({ user_id: 10003, nickname: expect.any(String), shut_up_time: expect.any(Number) })

    const [notice] = await request('_get_group_notice', { group_id: 30001 }) as Array<Record<string, unknown>>
    expect(notice).toMatchObject({
      message: { text: expect.any(String), image: [], images: [] },
      settings: expect.any(Object),
      read_num: 0,
      type: 6,
      pinned: 0,
      send_to_new_members: false,
    })
    await request('_del_group_notice', { group_id: 30001, fid: notice.notice_id })
    expect(control.getSnapshot().groups[0].announcements.map(({ id }) => id)).not.toContain(notice.notice_id)

    await request('set_group_kick_members', { group_id: 30001, user_id: [10004] })
    expect(control.getSnapshot().groups[0].members.map(({ participantId }) => participantId)).not.toContain('10004')
  })

  it('群系统消息是不分桶的数组，flag 能直接审批', async () => {
    const control = await createControl()
    const request = requester(await createSnowLuma(control))
    control.createUser({ id: '10004', name: '入群申请人' })
    control.createGroup({ id: '30005', name: '邀请群', members: [{ participantId: '10001', role: 'owner' }] })
    await control.performGroupAction({ action: 'request-join', operatorId: '10004', groupId: '30001', comment: '想加入' })
    await control.performGroupAction({ action: 'invite', operatorId: '10001', groupId: '30005', targetId: '20002' })

    const items = await request('get_group_system_msg') as Array<Record<string, unknown>>
    expect(Array.isArray(items)).toBe(true)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ group_id: 30001, requester_uin: 10004, requester_nick: '入群申请人', invitor_uin: 0, invitor_nick: '', message: '想加入', checked: false }),
      expect.objectContaining({ group_id: 30005, requester_uin: 10001, invitor_uin: 10001, checked: false }),
    ]))
    await expect(request('get_group_system_msg', { group_id: 30005 })).resolves.toHaveLength(1)
    await expect(control.getRuntimeBot('20002').internal._request('get_group_system_msg', { count: 0 })).rejects.toThrow('count')

    const join = items.find(({ group_id }) => group_id === 30001)!
    await request('set_group_add_request', { flag: join.flag, sub_type: 'add', approve: true })
    expect(control.getSnapshot().groups[0].members.map(({ participantId }) => participantId)).toContain('10004')
  })

  it('历史消息以 message_id 为锚并包含锚点，忽略 NapCat 的 message_seq', async () => {
    const control = await createControl()
    const request = requester(await createSnowLuma(control))
    const sent = []
    for (let index = 1; index <= 5; index += 1) {
      sent.push(await control.sendMessage({ operatorId: '10002', conversationId: 'group:30001', content: `历史${index}` }))
    }
    const idOf = (index: number) => getOneBotMessageId('snowluma', sent[index].messageId)
    const sequenceOf = (index: number) => getOneBotMessageSequence(sent[index].messageId)
    const texts = async (params: Record<string, unknown>) => ((await request('get_group_msg_history', { group_id: 30001, ...params }) as {
      messages: Array<{ raw_message: string }>
    }).messages.map(({ raw_message }) => raw_message))

    expect((await texts({ count: 2 }))).toEqual(['历史4', '历史5'])
    expect(await texts({ message_id: idOf(2), count: 2 })).toEqual(['历史2', '历史3'])
    expect(await texts({ message_id: idOf(2), count: 2, reverse_order: false })).toEqual(['历史3', '历史4'])
    expect(await texts({ message_seq: sequenceOf(2), count: 2 })).toEqual(['历史4', '历史5'])
    // 把消息序号当成 message_id 传，SnowLuma 找不到锚点，答空列表。
    expect(await texts({ message_id: sequenceOf(2), count: 2 })).toEqual([])
    expect(await texts({ message_id: 123456789, count: 2 })).toEqual([])
  })

  it('消息事件不带 real_id 与 message_format，get_msg 带 real_id 与群名', async () => {
    const control = await createControl()
    const bot = await createSnowLuma(control)
    const events: Array<Record<string, unknown>> = []
    bot.ctx.on('middleware', (session: Session) => {
      if (session.selfId === '20002') events.push((session as typeof session & { onebot: Record<string, unknown> }).onebot)
    })

    const sent = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '事件字段' })
    const event = events.find(({ self_id }) => self_id === 20002)!
    expect(event).toMatchObject({ message_id: expect.any(Number), message_seq: expect.any(Number), font: 0 })
    expect(event).not.toHaveProperty('real_id')
    expect(event).not.toHaveProperty('message_format')

    const message = await requester(bot)('get_msg', { message_id: getOneBotMessageId('snowluma', sent.messageId) }) as Record<string, unknown>
    expect(message).toMatchObject({ real_id: getOneBotMessageId('snowluma', sent.messageId), group_name: '测试群' })
    expect(message).not.toHaveProperty('message_format')
  })

  it('message_id 是与消息序号无关的哈希值，序号不能代替它', async () => {
    const control = await createControl()
    const bot = await createSnowLuma(control)
    const request = requester(bot)
    const events: Array<Record<string, unknown>> = []
    bot.ctx.on('middleware', (session: Session) => {
      if (session.selfId === '20002') events.push((session as typeof session & { onebot: Record<string, unknown> }).onebot)
    })

    const { message_id: messageId } = await request('send_group_msg', { group_id: 30001, message: '待撤回' }) as { message_id: number }
    const sent = control.getSnapshot().messages.at(-1)!
    const sequence = getOneBotMessageSequence(sent.id)
    expect(messageId).toBe(getOneBotMessageId('snowluma', sent.id))
    expect(messageId).not.toBe(sequence)
    await expect(request('get_msg', { message_id: messageId })).resolves.toMatchObject({ message_id: messageId, message_seq: sequence })
    await expect(bot.internal._request('get_msg', { message_id: sequence })).rejects.toThrow('消息不存在')
    await expect(bot.internal._request('delete_msg', { message_id: sequence })).rejects.toThrow()

    // 入站事件与其中的回复段同样用哈希 ID。
    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '回复', replyToMessageId: sent.id })
    const event = events.at(-1)!
    expect(event.message).toEqual(expect.arrayContaining([{ type: 'reply', data: { id: String(messageId) } }]))
    expect(event.raw_message).toContain(`[CQ:reply,id=${messageId}]`)

    await request('delete_msg', { message_id: messageId })
    expect(control.getSnapshot().messages.find(({ id }) => id === sent.id)?.lifecycle?.status).toBe('recalled')
  })

  it('表情回应只支持群消息，查询只认 emojiId 且不要 emojiType', async () => {
    const control = await createControl()
    const bot = await createSnowLuma(control)
    const request = requester(bot)
    const group = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '群消息' })
    const direct = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20002', content: '私聊消息' })

    await request('set_msg_emoji_like', { message_id: getOneBotMessageId('snowluma', group.messageId), emoji_id: '76' })
    await expect(bot.internal._request('set_msg_emoji_like', { message_id: getOneBotMessageId('snowluma', direct.messageId), emoji_id: '76' }))
      .rejects.toThrow('SnowLuma 不支持私聊消息的表情回应')
    await expect(request('fetch_emoji_like', { message_id: getOneBotMessageId('snowluma', group.messageId), emojiId: '76' })).resolves.toMatchObject({
      result: 0,
      errMsg: '',
      emojiLikesList: [expect.objectContaining({ tinyId: '20002' })],
    })
    await expect(bot.internal._request('fetch_emoji_like', { message_id: getOneBotMessageId('snowluma', group.messageId), emoji_id: '76' }))
      .rejects.toThrow('缺少 emojiId')
  })

  it('set_qq_profile 三项都可选，性别只收 0 到 2 的整数', async () => {
    const control = await createControl()
    const bot = await createSnowLuma(control)

    await expect(bot.internal._request('set_qq_profile', { sex: 2 })).resolves.toMatchObject({ status: 'ok' })
    expect(control.getSnapshot().participants.find(({ id }) => id === '20002')).toMatchObject({ name: 'SnowLuma 机器人', profile: { sex: 'female' } })
    await expect(bot.internal._request('set_qq_profile', { sex: 'male' })).rejects.toThrow('性别参数无效')
    await expect(bot.internal._request('set_qq_profile', { nickname: '' })).rejects.toThrow('机器人昵称不能为空')
  })
})
