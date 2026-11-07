import { App } from './helpers/app'
import type { Session } from '@satorijs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { getOneBotMessageSequence, getOneBotProfileBaseline } from '../src/onebot-profiles'

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

describe('OneBot 实现配置', () => {
  it('维护带快照日期和来源版本的独立能力基线', () => {
    const napcat = getOneBotProfileBaseline('napcat')
    const llbot = getOneBotProfileBaseline('llbot')

    expect(napcat).toMatchObject({
      id: 'napcat',
      label: 'NapCat',
      snapshotDate: '2026-07-24',
      sourceRevision: '33546b936e008c017b2b9c1c41a0bb4f9e86c5be',
    })
    expect(llbot).toMatchObject({
      id: 'llbot',
      label: 'LLBot',
      snapshotDate: '2026-07-24',
      sourceRevision: 'd6e2f485b8164597d04a2907d307739ecfcf4a55',
    })
    expect(napcat.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'get_version_info', description: expect.any(String), surface: 'standard', supported: true }),
      expect.objectContaining({ action: 'set_qq_profile', description: expect.any(String), surface: 'native', supported: true }),
      expect.objectContaining({ action: 'send_poke', aliases: ['friend_poke', 'group_poke'], description: expect.stringContaining('戳一戳') }),
    ]))
    expect(llbot.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'get_version_info', description: expect.any(String), surface: 'standard', supported: true }),
      expect.objectContaining({ action: 'set_qq_avatar', description: expect.any(String), surface: 'native', supported: true }),
      expect.objectContaining({ action: 'send_poke', aliases: ['friend_poke', 'group_poke'], description: expect.stringContaining('戳一戳') }),
      expect.objectContaining({ action: 'set_group_leave', surface: 'standard', supported: true }),
      expect.objectContaining({ action: 'send_forward_msg', aliases: ['send_group_forward_msg', 'send_private_forward_msg'], supported: true }),
      expect.objectContaining({ action: 'get_forward_msg', id: 'message.forward.get', supported: true }),
    ]))
    expect(napcat.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'group.notice.delete', action: '_del_group_notice', handler: 'delete_group_notice', supported: true }),
      expect.objectContaining({ id: 'group.member.kick-batch', action: 'set_group_kick_members', handler: 'batch_kick_group_members', supported: true }),
    ]))
    expect(llbot.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'group.notice.delete', action: '_delete_group_notice', handler: 'delete_group_notice', supported: true }),
      expect.objectContaining({ id: 'group.member.kick-batch', action: 'batch_delete_group_member', handler: 'batch_kick_group_members', supported: true }),
    ]))
    for (const baseline of [napcat, llbot]) {
      expect(baseline.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'group.member.shut-list', action: 'get_group_shut_list', aliases: ['getGroupShutList'], supported: true }),
      ]))
      // 四个补齐读写端的 action 在两种实现上同名，因此不按实现分叉声明；参数与返回差异在适配器里。
      expect(baseline.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'group.notice.list', action: '_get_group_notice', handler: 'get_group_notice', surface: 'native', supported: true }),
        expect.objectContaining({ id: 'group.system-msg', action: 'get_group_system_msg', handler: 'get_group_system_msg', surface: 'native', supported: true }),
        expect.objectContaining({ id: 'friend.remark.set', action: 'set_friend_remark', handler: 'set_friend_remark', surface: 'native', supported: true }),
        expect.objectContaining({ id: 'message.emoji-like.list', action: 'fetch_emoji_like', handler: 'fetch_emoji_like', surface: 'native', supported: true }),
      ]))
      // 两边上游都没有不带下划线的写法，沙盒也不得顺手加它。
      expect(baseline.capabilities.map(({ action }) => action)).not.toContain('get_group_notice')
      // 刻意偏离与沙盒限制写在作用说明里，能力覆盖界面因此看得见它们。
      const emojiLikeList = baseline.capabilities.find(({ id }) => id === 'message.emoji-like.list')!
      expect(emojiLikeList.description).toContain('不分页')
      expect(emojiLikeList.description).toContain('nickName')
    }
    expect(napcat.capabilities.filter(({ supported }) => supported).map(({ action }) => action))
      .not.toEqual(llbot.capabilities.filter(({ supported }) => supported).map(({ action }) => action))
  })

  it('同一领域能力按实现配置接受各自 action 与参数名', async () => {
    const control = await createControl()
    control.createBot({ id: '20002', name: 'LLBot 机器人', implementation: 'llbot', enabled: true })
    control.createUser({ id: '10004', name: 'NapCat 待移除成员' })
    control.createUser({ id: '10005', name: 'LLBot 待移除成员' })
    const group = control.getSnapshot().groups[0]
    control.updateGroup({
      id: group.id,
      name: group.name,
      members: [
        ...group.members,
        { participantId: '20002', role: 'admin' },
        { participantId: '10004', role: 'member' },
        { participantId: '10005', role: 'member' },
      ],
    })

    const firstAnnouncementId = control.getSnapshot().groups[0].announcements[0].id
    await control.bot.internal._request('_del_group_notice', { group_id: 30001, notice_id: firstAnnouncementId })
    control.setGroupAnnouncement({ operatorId: '20002', groupId: '30001', content: 'LLBot 公告' })
    const secondAnnouncementId = control.getSnapshot().groups[0].announcements[0].id
    await control.getRuntimeBot('20002').internal._request('_delete_group_notice', { group_id: 30001, notice_id: secondAnnouncementId })

    await control.bot.internal._request('set_group_kick_members', { group_id: 30001, user_id: [10004] })
    await control.getRuntimeBot('20002').internal._request('batch_delete_group_member', { group_id: 30001, user_ids: [10005] })

    const updatedGroup = control.getSnapshot().groups[0]
    expect(updatedGroup.announcements).toHaveLength(0)
    expect(updatedGroup.members.map(({ participantId }) => participantId)).not.toContain('10004')
    expect(updatedGroup.members.map(({ participantId }) => participantId)).not.toContain('10005')
  })

  it('两种实现都提供群禁言列表和 camelCase 群资料查询；禁言列表按各自上游的形状', async () => {
    const control = await createControl()
    control.createBot({ id: '20002', name: 'LLBot 机器人', implementation: 'llbot', enabled: true })
    const group = control.getSnapshot().groups[0]
    control.updateGroup({
      id: group.id,
      name: group.name,
      members: group.members.map((member) => member.participantId === '20001'
        ? { ...member, role: 'owner' as const }
        : member.participantId === '10001' ? { ...member, role: 'member' as const } : member)
        .concat({ participantId: '20002', role: 'admin' }),
    })

    await control.bot.internal._request('set_group_ban', { group_id: 30001, user_id: 10003, duration: 300 })
    for (const botId of ['20001', '20002']) {
      await expect(control.getRuntimeBot(botId).internal.getGroupInfo('30001'))
        .resolves.toMatchObject({ group_id: 30001 })
    }
    const shutList = async (botId: string) => {
      const { data } = await control.getRuntimeBot(botId).internal._request('get_group_shut_list', { group_id: '30001' }) as { data: Record<string, unknown>[] }
      expect(data).toHaveLength(1)
      return data[0]
    }
    // NapCat 原样转出 QQ 内核的 ShutUpGroupMember，LLBot 映射出同名 camelCase 子集；两者都没有 user_id。
    const napcat = await shutList('20001')
    expect(napcat).toMatchObject({ uin: '10003', nick: expect.any(String), cardName: expect.any(String), role: 2, isRobot: false })
    expect(napcat.shutUpTime).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(napcat.uid).not.toBe('10003')
    expect(napcat).not.toHaveProperty('user_id')
    const llbot = await shutList('20002')
    expect(Object.keys(llbot).sort()).toEqual([
      'cardName', 'joinTime', 'lastSpeakTime', 'memberRealLevel', 'memberSpecialTitle', 'nick', 'role', 'shutUpTime', 'uid', 'uin',
    ])
    expect(llbot).toMatchObject({ uin: '10003', role: 2, shutUpTime: napcat.shutUpTime })
  })

  it('提供 WebQQ 使用的好友分组，并只为 NapCat 提供最近会话', async () => {
    const control = await createControl()
    control.createBot({ id: '20002', name: 'LLBot 机器人', implementation: 'llbot', enabled: true })

    await expect(control.bot.internal._request('get_friends_with_category', {})).resolves.toMatchObject({
      data: [{
        categoryId: 0,
        categoryName: '我的好友',
        categoryMbCount: expect.any(Number),
        buddyList: expect.arrayContaining([
          expect.objectContaining({ user_id: 10001, nickname: '测试用户1' }),
        ]),
      }],
    })
    await expect(control.getRuntimeBot('20002').internal._request('get_friends_with_category', {})).resolves.toMatchObject({
      data: [expect.objectContaining({ categoryName: '我的好友', categoryMbCount: expect.any(Number) })],
    })

    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '最近会话测试',
    })
    await control.sendMessage({
      operatorId: '10002',
      conversationId: 'group:30001',
      content: '最近群聊测试',
    })
    await expect(control.bot.internal._request('get_recent_contact', { count: 50 })).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          chatType: 1,
          peerUin: '10001',
          peerName: '测试用户1',
          lastestMsg: expect.objectContaining({ raw_message: '最近会话测试' }),
        }),
        expect.objectContaining({
          chatType: 2,
          peerUin: '30001',
          peerName: '测试群',
          lastestMsg: expect.objectContaining({ raw_message: '最近群聊测试' }),
        }),
      ]),
    })
    await expect(control.getRuntimeBot('20002').internal._request('get_recent_contact', { count: 50 }))
      .rejects.toThrow('LLBot 基线不支持 OneBot action：get_recent_contact')
  })

  it('NapCat 与 LLBot 都提供私聊和群聊历史消息', async () => {
    const control = await createControl()
    control.createBot({ id: '20002', name: 'LLBot 机器人', implementation: 'llbot', enabled: true })
    const group = control.getSnapshot().groups[0]
    control.updateGroup({
      id: group.id,
      name: group.name,
      members: [...group.members, { participantId: '20002', role: 'admin' }],
    })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: 'NapCat 私聊历史' })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20002', content: 'LLBot 私聊历史' })
    await control.sendMessage({ operatorId: '10002', conversationId: 'group:30001', content: '群聊历史' })

    await expect(control.bot.internal._request('get_friend_msg_history', {
      user_id: 10001,
      message_seq: 0,
      count: 30,
    })).resolves.toMatchObject({ data: { messages: [expect.objectContaining({ raw_message: 'NapCat 私聊历史' })] } })
    await expect(control.getRuntimeBot('20002').internal._request('get_friend_msg_history', {
      user_id: 10001,
      message_seq: 0,
      count: 30,
      reverseOrder: false,
    })).resolves.toMatchObject({ data: { messages: [expect.objectContaining({ raw_message: 'LLBot 私聊历史' })] } })
    for (const botId of ['20001', '20002']) {
      await expect(control.getRuntimeBot(botId).internal._request('get_group_msg_history', {
        group_id: 30001,
        message_seq: 0,
        count: 30,
        ...(botId === '20002' ? { reverseOrder: false } : {}),
      })).resolves.toMatchObject({ data: { messages: [expect.objectContaining({ raw_message: '群聊历史' })] } })
    }
  })

  it('群聊历史按 message_seq 翻页时能读取超过可见快照窗口的更早消息', async () => {
    const control = await createControl()
    const first = await control.sendMessage({
      operatorId: '10002',
      conversationId: 'group:30001',
      content: '更早的群聊历史',
    })
    for (let index = 1; index <= 50; index += 1) {
      await control.sendMessage({
        operatorId: '10002',
        conversationId: 'group:30001',
        content: `最近群聊历史${index}`,
      })
    }

    const firstPage = await control.bot.internal._request('get_group_msg_history', {
      group_id: 30001,
      count: 50,
    }) as { data: { messages: Array<{ raw_message: string, message_seq: number }> } }
    expect(firstPage.data.messages.map(({ raw_message }) => raw_message)).toEqual([
      ...Array.from({ length: 50 }, (_, index) => `最近群聊历史${index + 1}`),
    ])

    const olderPage = await control.bot.internal._request('get_group_msg_history', {
      group_id: 30001,
      message_seq: firstPage.data.messages[0].message_seq,
      count: 50,
      reverseOrder: true,
    }) as { data: { messages: Array<{ raw_message: string, message_seq: number }> } }
    expect(olderPage.data.messages.map(({ raw_message }) => raw_message)).toEqual(['更早的群聊历史'])
    expect(olderPage.data.messages[0].message_seq).toBe(getOneBotMessageSequence(first.messageId))

    // Character 会继续用最旧一条的 message_seq 翻页；游标必须在完整逻辑会话中解析，
    // 且到达起点时返回空列表而不是抛错，否则整段已拉取历史会被丢弃。
    const beforeOldest = await control.bot.internal._request('get_group_msg_history', {
      group_id: 30001,
      message_seq: getOneBotMessageSequence(first.messageId),
      count: 50,
      reverseOrder: true,
    }) as { data: { messages: Array<{ raw_message: string }> } }
    expect(beforeOldest.data.messages).toEqual([])
    await expect(control.bot.internal._request('get_msg', {
      message_id: getOneBotMessageSequence(first.messageId),
    })).resolves.toMatchObject({
      data: { raw_message: '更早的群聊历史', message_id: getOneBotMessageSequence(first.messageId) },
    })
  })

  it('按机器人实现配置生成版本返回并隔离能力覆盖', async () => {
    const control = await createControl()
    control.createBot({
      id: '20002',
      name: 'LLBot 机器人',
      implementation: 'llbot',
      enabled: true,
      disabledCapabilities: ['set_qq_profile'],
    })
    control.createBot({ id: '20003', name: 'NapCat 机器人', implementation: 'napcat', enabled: true })

    await expect(control.bot.internal._request('get_version_info', {})).resolves.toMatchObject({
      data: { app_name: 'NapCat.Onebot', protocol_version: 'v11' },
    })
    await expect(control.getRuntimeBot('20002').internal._request('get_version_info', {})).resolves.toMatchObject({
      data: { app_name: 'LLOneBot', protocol_version: 'v11' },
    })
    await expect(control.getRuntimeBot('20002').internal._request('set_qq_profile', { nickname: '不可修改' }))
      .rejects.toThrow('能力已被禁用：set_qq_profile')
    await expect(control.getRuntimeBot('20003').internal._request('set_qq_profile', { nickname: '已修改' }))
      .resolves.toMatchObject({ status: 'ok', retcode: 0 })
    expect(control.getSnapshot().participants.find(({ id }) => id === '20003')).toMatchObject({ name: '已修改' })
  })

  it('按接收机器人实现配置生成原始消息字段', async () => {
    const control = await createControl()
    control.createBot({ id: '20002', name: 'LLBot 机器人', implementation: 'llbot', enabled: true })
    const group = control.getSnapshot().groups[0]
    control.updateGroup({
      id: group.id,
      name: group.name,
      members: [...group.members, { participantId: '20002', role: 'admin' }],
    })
    const events: Array<Record<string, unknown>> = []
    for (const botId of ['20001', '20002']) {
      control.getRuntimeBot(botId).ctx.on('middleware', (session: Session) => {
        if (session.selfId === botId) events.push((session as typeof session & { onebot: Record<string, unknown> }).onebot)
      })
    }

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '实现字段' })

    const napcatEvent = events.find(({ self_id }) => self_id === 20001)
    const llbotEvent = events.find(({ self_id }) => self_id === 20002)
    expect(napcatEvent).toEqual(expect.objectContaining({
      message_id: expect.any(Number),
      message_seq: expect.any(Number),
      real_id: expect.any(Number),
      message_format: 'array',
      font: 0,
    }))
    expect(llbotEvent).toEqual(expect.objectContaining({
      message_id: napcatEvent?.message_id,
      message_seq: napcatEvent?.message_seq,
      message_format: 'array',
      font: 0,
    }))
    expect(llbotEvent).not.toHaveProperty('real_id')
  })

  it('能力矩阵解释禁用能力与未实现 action', async () => {
    const control = await createControl()
    control.updateBot({
      id: '20001',
      name: 'ChatLuna',
      implementation: 'napcat',
      enabled: true,
      disabledCapabilities: ['set_qq_avatar'],
    })

    expect(control.getBotCapabilities('20001')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'set_qq_avatar',
        surface: 'native',
        supported: false,
        reason: '已被机器人能力覆盖禁用',
      }),
    ]))
    await expect(control.bot.internal._request('set_qq_avatar', { file: 'https://example.com/avatar.png' }))
      .rejects.toThrow('能力已被禁用：set_qq_avatar')
    await expect(control.bot.internal._request('host_only_action', {}))
      .rejects.toThrow('NapCat 基线不支持 OneBot action：host_only_action')
  })

  it('bot.internal 具名方法不会绕过能力覆盖', async () => {
    const control = await createControl()
    control.updateBot({
      id: '20001',
      name: 'ChatLuna',
      implementation: 'napcat',
      enabled: true,
      disabledCapabilities: ['set_friend_add_request', 'set_group_add_request'],
    })

    await expect(control.bot.internal.set_friend_add_request({ flag: 'missing', approve: true }))
      .rejects.toThrow('能力已被禁用：set_friend_add_request')
    await expect(control.bot.internal.set_group_add_request({ flag: 'missing', sub_type: 'add', approve: true }))
      .rejects.toThrow('能力已被禁用：set_group_add_request')
  })

  it('原生 poke 方法别名复用同一会话交互', async () => {
    const control = await createControl()

    await control.bot.internal._request('group_poke', { group_id: 30001, user_id: 10001 })
    const message = control.getSnapshot().messages.at(-1)

    expect(message).toMatchObject({
      conversationId: 'group:30001',
      authorId: '20001',
      event: { type: 'poke', targetId: '10001' },
    })
  })
})
