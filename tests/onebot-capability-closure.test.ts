import { App } from './helpers/app'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'

/**
 * 四处原本只有单向入口的场景状态：群公告、群系统消息、好友备注与表情回应参与者。
 *
 * 断言集中在两件事上：读写两端落在同一份场景状态上（写完立刻读得回来、列出来的申请能直接审批），
 * 以及两种实现配置的参数与返回形状按各自上游出现而不是取并集——后者是这四个 action 存在的理由，
 * 合并掉差异会让插件在沙盒上能跑、换到真机上翻车。
 */

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createControl() {
  const app = new App()
  const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-capability-closure-'))
  temporaryDirectories.push(mediaDirectory)
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, { mediaDirectory })
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  return control
}

/** 默认场景里的 NapCat 机器人是 20001；LLBot 侧统一新建 20002 并放进同样的位置。 */
async function createLlbot(control: SandboxControlService, role: 'owner' | 'admin' | 'member' = 'admin') {
  control.createBot({ id: '20002', name: 'LLBot 机器人', implementation: 'llbot', enabled: true })
  const group = control.getSnapshot().groups.find(({ id }) => id === '30001')!
  control.updateGroup({
    id: group.id,
    name: group.name,
    members: [...group.members, { participantId: '20002', role }],
  })
  return control.getRuntimeBot('20002')
}

/** 读取型 action 不得改动场景：revision 与快照都要逐字节相同。 */
async function expectSceneUnchanged(control: SandboxControlService, read: () => Promise<unknown>) {
  const before = JSON.stringify(control.getSnapshot())
  await read()
  expect(JSON.stringify(control.getSnapshot())).toBe(before)
}

interface GroupSystemMsgData {
  invited_requests: Array<Record<string, unknown>>
  InvitedRequest?: Array<Record<string, unknown>>
  join_requests: Array<Record<string, unknown>>
}

async function readGroupSystemMsg(bot: { internal: { _request(action: string, params: Record<string, unknown>): Promise<unknown> } }, params: Record<string, unknown> = {}) {
  return (await bot.internal._request('get_group_system_msg', params) as { data: GroupSystemMsgData }).data
}

/**
 * 摆出四种申请：两条机器人有权审批的入群申请、一条它只是普通成员因此看不见的、发给它自己的
 * 群邀请与发给别人的群邀请，外加一条好友申请（这个 action 只管群）。
 */
async function seedGroupSystemMessages(control: SandboxControlService) {
  control.createUser({ id: '10004', name: '入群申请人' })
  control.createUser({ id: '10005', name: '旁观群申请人' })
  control.createUser({ id: '10006', name: '第二位入群申请人' })
  control.createGroup({
    id: '30004',
    name: '旁观群',
    members: [
      { participantId: '10001', role: 'owner' },
      { participantId: '20001', role: 'member' },
      { participantId: '20002', role: 'member' },
    ],
  })
  control.createGroup({ id: '30005', name: '邀请群', members: [{ participantId: '10001', role: 'owner' }] })
  await control.performGroupAction({ action: 'request-join', operatorId: '10004', groupId: '30001', comment: '想加入' })
  await control.performGroupAction({ action: 'request-join', operatorId: '10006', groupId: '30001' })
  await control.performGroupAction({ action: 'request-join', operatorId: '10005', groupId: '30004' })
  // 只能邀请好友入群，10001 与 10002 默认不是好友。
  const friend = await control.performFriendAction({ action: 'request', operatorId: '10002', targetId: '10001' })
  await control.performFriendAction({ action: 'handle-request', operatorId: '10001', requestId: friend.requestId!, approve: true })
  for (const targetId of ['20001', '20002', '10002']) {
    await control.performGroupAction({ action: 'invite', operatorId: '10001', groupId: '30005', targetId })
  }
  await control.performFriendAction({ action: 'delete', operatorId: '10004', targetId: '20001' })
  await control.performFriendAction({ action: 'request', operatorId: '10004', targetId: '20001', comment: '好友申请' })
}

function findJoinRequestId(control: SandboxControlService, requesterId: string, groupId: string) {
  return control.getSnapshot().requests.find((request) => request.type === 'group'
    && (request.subType ?? 'add') === 'add' && request.requesterId === requesterId && request.groupId === groupId)!.id
}

function findInviteRequestId(control: SandboxControlService, targetId: string) {
  return control.getSnapshot().requests.find((request) => request.type === 'group'
    && request.subType === 'invite' && request.targetId === targetId)!.id
}

describe('群公告读取', () => {
  it('按存储顺序返回公告，publish_time 是秒级整数', async () => {
    const control = await createControl()
    control.setGroupAnnouncement({ operatorId: '10001', groupId: '30001', content: '第二条公告' })
    const announcements = control.getSnapshot().groups[0].announcements

    const result = await control.bot.internal._request('_get_group_notice', { group_id: 30001 }) as {
      data: Array<{ notice_id: string, sender_id: number, publish_time: number, message: { text: string } }>
    }

    // setGroupAnnouncement 用 unshift，因此最新在前；handler 不重新排序。
    expect(result.data.map(({ notice_id }) => notice_id)).toEqual(announcements.map(({ id }) => id))
    expect(result.data.map(({ message }) => message.text)).toEqual(['第二条公告', '欢迎使用测试群验证群聊插件功能'])
    expect(result.data.map(({ sender_id }) => sender_id)).toEqual([10001, 10001])
    for (const [index, notice] of result.data.entries()) {
      expect(Number.isInteger(notice.publish_time)).toBe(true)
      expect(notice.publish_time).toBe(Math.floor(new Date(announcements[index].createdAt).getTime() / 1000))
    }
  })

  it('NapCat 同时给 image 与 images 且不给 settings，LLBot 只给 images 且 settings 五项为 false', async () => {
    const control = await createControl()
    const llbot = await createLlbot(control)

    const napcatNotice = (await control.bot.internal._request('_get_group_notice', { group_id: 30001 }) as {
      data: Array<Record<string, unknown> & { message: Record<string, unknown> }>
    }).data[0]
    const llbotNotice = (await llbot.internal._request('_get_group_notice', { group_id: '30001' }) as {
      data: Array<Record<string, unknown> & { message: Record<string, unknown> }>
    }).data[0]

    expect(napcatNotice.message.image).toEqual([])
    expect(napcatNotice.message.images).toEqual([])
    expect(napcatNotice).not.toHaveProperty('settings')
    expect(napcatNotice).not.toHaveProperty('read_num')

    expect(llbotNotice.message.images).toEqual([])
    expect(llbotNotice.message).not.toHaveProperty('image')
    expect(llbotNotice.settings).toEqual({
      is_show_edit_card: false,
      tip_window: false,
      confirm_required: false,
      pinned: false,
      send_new_member: false,
    })
    expect(llbotNotice).not.toHaveProperty('read_num')
  })

  it('群里没有公告时返回空数组，机器人不在群里时与删除公告同一句拒绝', async () => {
    const control = await createControl()
    control.createGroup({ id: '30002', name: '无公告群', members: [{ participantId: '10001', role: 'owner' }, { participantId: '20001', role: 'member' }] })
    control.createGroup({ id: '30003', name: '无机器人群', members: [{ participantId: '10001', role: 'owner' }] })

    await expect(control.bot.internal._request('_get_group_notice', { group_id: 30002 }))
      .resolves.toMatchObject({ status: 'ok', retcode: 0, data: [] })
    // 空数组会让插件以为群里没公告，因此不在群里必须拒绝，而且与 _del_group_notice 逐字相同。
    await expect(control.bot.internal._request('_get_group_notice', { group_id: 30003 }))
      .rejects.toThrow('参与者不在群组中：20001')
    await expect(control.bot.internal._request('_del_group_notice', { group_id: 30003, notice_id: 'announcement:welcome' }))
      .rejects.toThrow('参与者不在群组中：20001')
  })

  it('读取不改动场景，能力禁用后被拒，不带下划线的写法仍按基线不支持拒绝', async () => {
    const control = await createControl()
    await expectSceneUnchanged(control, () => control.bot.internal._request('_get_group_notice', { group_id: 30001 }))

    await expect(control.bot.internal._request('get_group_notice', { group_id: 30001 }))
      .rejects.toThrow('NapCat 基线不支持 OneBot action：get_group_notice')

    control.updateBot({ id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: true, disabledCapabilities: ['group.notice.list'] })
    await expect(control.bot.internal._request('_get_group_notice', { group_id: 30001 }))
      .rejects.toThrow('能力已被禁用：group.notice.list')
    // 删除公告是另一项能力，不受这次禁用影响。
    await expect(control.bot.internal._request('_del_group_notice', {
      group_id: 30001,
      notice_id: control.getSnapshot().groups[0].announcements[0].id,
    })).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('群系统消息读取', () => {
  it('只列出机器人有权审批的入群申请与发给它自己的群邀请', async () => {
    const control = await createControl()
    const llbot = await createLlbot(control)
    await seedGroupSystemMessages(control)

    const napcat = await readGroupSystemMsg(control.bot)
    const llbotData = await readGroupSystemMsg(llbot)
    const visibleJoinIds = [findJoinRequestId(control, '10004', '30001'), findJoinRequestId(control, '10006', '30001')]

    expect(napcat.join_requests.map(({ request_id }) => request_id)).toEqual(visibleJoinIds)
    expect(napcat.invited_requests.map(({ request_id }) => request_id)).toEqual([findInviteRequestId(control, '20001')])
    // NapCat 的兼容别名桶与 invited_requests 内容相同；LLBot 只有两个桶。
    expect(napcat.InvitedRequest).toEqual(napcat.invited_requests)
    expect(llbotData.join_requests.map(({ request_id }) => request_id)).toEqual(visibleJoinIds)
    expect(llbotData.invited_requests.map(({ request_id }) => request_id)).toEqual([findInviteRequestId(control, '20002')])
    expect(llbotData).not.toHaveProperty('InvitedRequest')

    // 机器人只是普通成员的群、发给别人的邀请、以及好友申请都不出现。
    const hiddenIds = [
      findJoinRequestId(control, '10005', '30004'),
      findInviteRequestId(control, '10002'),
      control.getSnapshot().requests.find(({ type }) => type === 'friend')!.id,
    ]
    for (const data of [napcat, llbotData]) {
      const listed = [...data.join_requests, ...data.invited_requests].map(({ request_id }) => request_id)
      for (const hidden of hiddenIds) expect(listed).not.toContain(hidden)
    }
  })

  it('两种实现的每项字段按各自上游出现，取值全部来自场景', async () => {
    const control = await createControl()
    const llbot = await createLlbot(control)
    await seedGroupSystemMessages(control)
    const joinId = findJoinRequestId(control, '10004', '30001')

    const napcat = await readGroupSystemMsg(control.bot)
    const llbotData = await readGroupSystemMsg(llbot)

    // NapCat 的两个桶共用同一份 schema：申请人落在 invitor_* 上，另有一个重复的 requester_nick。
    expect(napcat.join_requests[0]).toEqual({
      request_id: joinId,
      group_id: 30001,
      group_name: '测试群',
      message: '想加入',
      checked: false,
      actor: 0,
      invitor_uin: 10004,
      invitor_nick: '入群申请人',
      requester_nick: '入群申请人',
    })
    expect(napcat.invited_requests[0]).toEqual({
      request_id: findInviteRequestId(control, '20001'),
      invitor_uin: 10001,
      invitor_nick: '测试用户1',
      group_id: 30005,
      group_name: '邀请群',
      message: '',
      checked: false,
      actor: 0,
      requester_nick: '测试用户1',
    })
    // LLBot 的入群申请用 requester_*，群邀请用 invitor_* 且不带附言。
    expect(llbotData.join_requests[0]).toEqual({
      request_id: joinId,
      requester_uin: 10004,
      requester_nick: '入群申请人',
      message: '想加入',
      group_id: 30001,
      group_name: '测试群',
      checked: false,
      actor: 0,
    })
    expect(llbotData.invited_requests[0]).toEqual({
      request_id: findInviteRequestId(control, '20002'),
      invitor_uin: 10001,
      invitor_nick: '测试用户1',
      group_id: 30005,
      group_name: '邀请群',
      checked: false,
      actor: 0,
    })

    // 没有附言时按空串返回，而不是 undefined。
    expect(napcat.join_requests[1]).toMatchObject({ message: '', requester_nick: '第二位入群申请人' })
    expect(llbotData.join_requests[1]).toMatchObject({ message: '', requester_nick: '第二位入群申请人' })

    // checked 与场景里那条申请的 status 对齐。诚实地说：`status` 的类型只有 'pending'，因此这条
    // 等式两边今天恒为 false，它抓不出「把 checked 写死成 false」——真给申请加上「已处理」状态
    // 之后它才开始有区分力。留着是为了让那一天不必重新想这条不变量该怎么写。
    const statusOf = (requestId: unknown) => control.getSnapshot().requests.find(({ id }) => id === requestId)!.status
    const listed = [...napcat.join_requests, ...napcat.invited_requests, ...llbotData.join_requests, ...llbotData.invited_requests]
    expect(listed).not.toHaveLength(0)
    for (const item of listed) expect(item.checked).toBe(statusOf(item.request_id) !== 'pending')
  })

  it('NapCat 按 count 截断系统消息总量，LLBot 忽略 count 且不报错', async () => {
    const control = await createControl()
    const llbot = await createLlbot(control)
    await seedGroupSystemMessages(control)

    // 上游的 count 限的是一次取多少条系统消息，分桶发生在截断之后。
    const napcat = await readGroupSystemMsg(control.bot, { count: 1 })
    expect(napcat.join_requests.map(({ request_id }) => request_id)).toEqual([findJoinRequestId(control, '10004', '30001')])
    expect(napcat.invited_requests).toEqual([])
    expect(napcat.InvitedRequest).toEqual([])
    expect(await readGroupSystemMsg(control.bot, { count: '1' })).toEqual(napcat)

    const llbotData = await readGroupSystemMsg(llbot, { count: 1 })
    expect(llbotData.join_requests).toHaveLength(2)
    expect(llbotData.invited_requests).toHaveLength(1)
  })

  it('列出来的 request_id 能直接审批，审批后那条申请从场景里消失', async () => {
    const control = await createControl()
    await createLlbot(control)
    await seedGroupSystemMessages(control)

    const napcat = await readGroupSystemMsg(control.bot)
    const flag = napcat.join_requests[0].request_id
    await expect(control.bot.internal._request('set_group_add_request', { flag, sub_type: 'add', approve: true }))
      .resolves.toMatchObject({ status: 'ok', retcode: 0, data: null })

    const snapshot = control.getSnapshot()
    expect(snapshot.requests.some(({ id }) => id === flag)).toBe(false)
    expect(snapshot.groups.find(({ id }) => id === '30001')!.members.map(({ participantId }) => participantId)).toContain('10004')
    const afterApproval = await readGroupSystemMsg(control.bot)
    expect(afterApproval.join_requests.map(({ request_id }) => request_id)).not.toContain(flag)
  })

  it('没有可见申请时各桶都是空数组，读取不改动场景，能力禁用后被拒', async () => {
    const control = await createControl()
    const llbot = await createLlbot(control)

    expect(await readGroupSystemMsg(control.bot)).toEqual({ invited_requests: [], InvitedRequest: [], join_requests: [] })
    expect(await readGroupSystemMsg(llbot)).toEqual({ invited_requests: [], join_requests: [] })

    await seedGroupSystemMessages(control)
    await expectSceneUnchanged(control, () => readGroupSystemMsg(control.bot))

    control.updateBot({ id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: true, disabledCapabilities: ['group.system-msg'] })
    await expect(control.bot.internal._request('get_group_system_msg', {}))
      .rejects.toThrow('能力已被禁用：group.system-msg')
  })
})

describe('好友备注写入', () => {
  it('写入后好友列表与最近会话立刻返回同一份值，前后空白被 trim', async () => {
    const control = await createControl()
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '备注复查' })
    const revisionBefore = control.getSnapshot().revision

    await expect(control.bot.internal._request('set_friend_remark', { user_id: 10001, remark: '  主要联系人  ' }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null })

    expect(control.getSnapshot().revision).toBeGreaterThan(revisionBefore)
    expect(control.getSnapshot().friendships.find(({ participantIds }) => participantIds.includes('10001') && participantIds.includes('20001'))!.remarks)
      .toEqual({ 20001: '主要联系人' })
    const friendList = await control.bot.internal._request('get_friend_list', {}) as { data: Array<{ user_id: number, remark: string }> }
    expect(friendList.data.find(({ user_id }) => user_id === 10001)!.remark).toBe('主要联系人')
    expect((await control.bot.getFriendList()).data.find(({ user }) => user?.id === '10001')!.nick).toBe('主要联系人')
    const recent = await control.bot.internal._request('get_recent_contact', { count: 50 }) as { data: Array<{ peerUin: string, remark: string }> }
    expect(recent.data.find(({ peerUin }) => peerUin === '10001')!.remark).toBe('主要联系人')
  })

  it('空串与省略 remark 都删除该键而不是写入空串，user_id 收数字与字符串', async () => {
    const control = await createControl()
    const friendship = () => control.getSnapshot().friendships
      .find(({ participantIds }) => participantIds.includes('10001') && participantIds.includes('20001'))!

    await control.bot.internal._request('set_friend_remark', { user_id: '10001', remark: '先写一个' })
    expect(friendship().remarks).toEqual({ 20001: '先写一个' })
    await control.bot.internal._request('set_friend_remark', { user_id: '10001', remark: '' })
    // 删除该键而不是写入空串，因此 nick 回落空串。
    expect(friendship().remarks).toEqual({})
    const cleared = await control.bot.internal._request('get_friend_list', {}) as { data: Array<{ user_id: number, remark: string }> }
    expect(cleared.data.find(({ user_id }) => user_id === 10001)!.remark).toBe('')

    await control.bot.internal._request('set_friend_remark', { user_id: 10001, remark: '再写一个' })
    expect(friendship().remarks).toEqual({ 20001: '再写一个' })
    // 省略 remark 与两种实现的上游默认值（空串）一致。
    await control.bot.internal._request('set_friend_remark', { user_id: 10001 })
    expect(friendship().remarks).toEqual({})
  })

  it('LLBot 同样支持，且两条通道的拒绝文案逐字相同', async () => {
    const control = await createControl()
    const llbot = await createLlbot(control)
    // createUser 会与当前全部机器人静默建立好友关系，因此这位用户同时是两个机器人的好友。
    control.createUser({ id: '10004', name: '双机器人好友' })

    await expect(llbot.internal._request('set_friend_remark', { user_id: 10004, remark: 'LLBot 备注' }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null })
    expect(control.getSnapshot().friendships.find(({ participantIds }) => participantIds.includes('10004') && participantIds.includes('20002'))!.remarks)
      .toEqual({ 20002: 'LLBot 备注' })

    await control.performFriendAction({ action: 'delete', operatorId: '10004', targetId: '20001' })
    await expect(control.bot.internal._request('set_friend_remark', { user_id: 10004, remark: '不该写入' }))
      .rejects.toThrow('好友关系不存在')
    await expect(control.performFriendAction({ action: 'set-remark', operatorId: '20001', targetId: '10004', remark: '不该写入' }))
      .rejects.toThrow('好友关系不存在')
    await expect(control.bot.internal._request('set_friend_remark', { user_id: 20001, remark: '不该写入' }))
      .rejects.toThrow('不能对自己执行好友操作')
    await expect(control.performFriendAction({ action: 'set-remark', operatorId: '20001', targetId: '20001', remark: '不该写入' }))
      .rejects.toThrow('不能对自己执行好友操作')
  })

  it('能力禁用后被拒，删除好友仍是另一项能力', async () => {
    const control = await createControl()
    control.updateBot({ id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: true, disabledCapabilities: ['friend.remark.set'] })

    await expect(control.bot.internal._request('set_friend_remark', { user_id: 10001, remark: '不该写入' }))
      .rejects.toThrow('能力已被禁用：friend.remark.set')
    await expect(control.bot.internal._request('delete_friend', { user_id: 10003 }))
      .resolves.toMatchObject({ status: 'ok' })
  })
})

interface EmojiLikeData {
  emojiLikesList: Array<{ tinyId: string, nickName: string, headUrl: string }>
  cookie: string
  isLastPage: boolean
  isFirstPage: boolean
  result?: number
  errMsg?: string
}

async function readEmojiLike(bot: { internal: { _request(action: string, params: Record<string, unknown>): Promise<unknown> } }, params: Record<string, unknown>) {
  return (await bot.internal._request('fetch_emoji_like', params) as { data: EmojiLikeData }).data
}

describe('表情回应参与者读取', () => {
  /** 群里三个人给同一个 emoji 贴回应；其中一次是重复贴，聚合语义要求只出现一次。 */
  async function seedReactions(control: SandboxControlService) {
    const sent = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '表情目标' })
    for (const operatorId of ['10002', '10003', '10003']) {
      await control.setMessageReaction({ operatorId, messageId: sent.messageId, emojiId: '76', enabled: true })
    }
    await control.bot.internal._request('set_msg_emoji_like', { message_id: sent.messageId, emoji_id: '76' })
    return sent.messageId
  }

  it('返回参与者实体上的真名与头像，同一人只出现一次', async () => {
    const control = await createControl()
    const messageId = await seedReactions(control)
    const avatarOf = (id: string) => control.getSnapshot().participants.find((participant) => participant.id === id)!.avatar

    const data = await readEmojiLike(control.bot, { message_id: messageId, emojiId: '76', emojiType: 1 })

    expect(data).toEqual({
      emojiLikesList: [
        { tinyId: '10002', nickName: '测试用户2', headUrl: avatarOf('10002') },
        { tinyId: '10003', nickName: '测试用户3', headUrl: avatarOf('10003') },
        { tinyId: '20001', nickName: 'ChatLuna', headUrl: avatarOf('20001') },
      ],
      // 沙盒不分页，因此 cookie 恒为空串、isFirstPage 恒为真。
      cookie: '',
      isLastPage: true,
      isFirstPage: true,
      // NapCat 的返回额外带这两个字段。
      result: 0,
      errMsg: '',
    })
    // 该消息上没人贴过这个 emoji 与「这条消息没有回应」是同一件事，返回空列表而不是报错。
    await expect(readEmojiLike(control.bot, { message_id: messageId, emojiId: '66', emojiType: 1 }))
      .resolves.toMatchObject({ emojiLikesList: [], isLastPage: true, isFirstPage: true })
  })

  it('NapCat 只认 camelCase 的 emojiId 且 emojiType 必填', async () => {
    const control = await createControl()
    const messageId = await seedReactions(control)

    await expect(control.bot.internal._request('fetch_emoji_like', { message_id: messageId, emojiType: 1 }))
      .rejects.toThrow('fetch_emoji_like 缺少 emojiId')
    await expect(control.bot.internal._request('fetch_emoji_like', { message_id: messageId, emojiId: '76' }))
      .rejects.toThrow('fetch_emoji_like 缺少 emojiType')
    // snake_case 拼写在 NapCat 上真的不通，兼容掉会让插件换到真机上崩。
    await expect(control.bot.internal._request('fetch_emoji_like', { message_id: messageId, emoji_id: '76', emojiType: 1 }))
      .rejects.toThrow('fetch_emoji_like 缺少 emojiId')
  })

  it('LLBot 接受两种拼写、忽略 emojiType，且不返回 result 与 errMsg', async () => {
    const control = await createControl()
    const llbot = await createLlbot(control)
    const messageId = await seedReactions(control)
    const participantIds = ['10002', '10003', '20001']

    for (const params of [
      { emoji_id: '76' },
      { emojiId: '76' },
      { emoji_id: '76', emojiType: '被忽略' },
    ]) {
      const data = await readEmojiLike(llbot, { message_id: messageId, ...params })
      expect(data.emojiLikesList.map(({ tinyId }) => tinyId)).toEqual(participantIds)
      expect(data).not.toHaveProperty('result')
      expect(data).not.toHaveProperty('errMsg')
    }
    await expect(llbot.internal._request('fetch_emoji_like', { message_id: messageId }))
      .rejects.toThrow('fetch_emoji_like 缺少 emoji_id')
    // 全是空白与没传是同一件事：LLBot 上游对空 emoji ID 明确失败。
    await expect(llbot.internal._request('fetch_emoji_like', { message_id: messageId, emoji_id: '   ' }))
      .rejects.toThrow('fetch_emoji_like 缺少 emoji_id')
  })

  it('emoji ID 的前后空白按写入侧同样归一化，贴完能按同一个参数查回来', async () => {
    const control = await createControl()
    const sent = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '空白参数目标' })

    // applyMessageReaction 存的是 trim 过的 emojiId，读取必须跟着归一化才查得到自己刚写的回应。
    await control.bot.internal._request('set_msg_emoji_like', { message_id: sent.messageId, emoji_id: '  76  ' })
    await expect(readEmojiLike(control.bot, { message_id: sent.messageId, emojiId: '  76  ', emojiType: 1 }))
      .resolves.toMatchObject({ emojiLikesList: [expect.objectContaining({ tinyId: '20001' })] })
  })

  it('count 生效：装不下时截断且 isLastPage 为假，装得下时两个 page 标记都为真', async () => {
    const control = await createControl()
    const messageId = await seedReactions(control)

    const truncated = await readEmojiLike(control.bot, { message_id: messageId, emojiId: '76', emojiType: 1, count: 2 })
    expect(truncated.emojiLikesList.map(({ tinyId }) => tinyId)).toEqual(['10002', '10003'])
    expect(truncated.isLastPage).toBe(false)
    expect(truncated.isFirstPage).toBe(true)
    expect(truncated.cookie).toBe('')

    const complete = await readEmojiLike(control.bot, { message_id: messageId, emojiId: '76', emojiType: 1, count: 5 })
    expect(complete.emojiLikesList).toHaveLength(3)
    expect(complete.isLastPage).toBe(true)
    expect(complete.isFirstPage).toBe(true)
  })

  it('撤回的消息与机器人看不见的消息都按既有文案拒绝', async () => {
    const control = await createControl()
    const messageId = await seedReactions(control)
    control.createGroup({
      id: '30006',
      name: '无机器人群',
      members: [{ participantId: '10001', role: 'owner' }, { participantId: '10002', role: 'member' }],
    })
    const hidden = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30006', content: '机器人看不见' })

    await expect(control.bot.internal._request('fetch_emoji_like', { message_id: hidden.messageId, emojiId: '76', emojiType: 1 }))
      .rejects.toThrow(`消息不存在：${hidden.messageId}`)

    await control.recallMessage({ operatorId: '10001', messageId, conversationId: 'group:30001' })
    // 撤回的语义是原文不再可读，谁贴过表情同样不该还查得出。
    await expect(control.bot.internal._request('fetch_emoji_like', { message_id: messageId, emojiId: '76', emojiType: 1 }))
      .rejects.toThrow(`消息已撤回：${messageId}`)
  })

  it('贴表情、查参与者、撤回回应构成闭环；读取不改动场景，能力禁用后被拒', async () => {
    const control = await createControl()
    const sent = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '闭环目标' })

    await control.bot.internal._request('set_msg_emoji_like', { message_id: sent.messageId, emoji_id: '128077' })
    await expect(readEmojiLike(control.bot, { message_id: sent.messageId, emojiId: '128077', emojiType: 2 }))
      .resolves.toMatchObject({ emojiLikesList: [expect.objectContaining({ tinyId: '20001' })] })

    await expectSceneUnchanged(control, () => readEmojiLike(control.bot, { message_id: sent.messageId, emojiId: '128077', emojiType: 2 }))

    await control.bot.internal._request('set_msg_emoji_like', { message_id: sent.messageId, emoji_id: '128077', set: false })
    await expect(readEmojiLike(control.bot, { message_id: sent.messageId, emojiId: '128077', emojiType: 2 }))
      .resolves.toMatchObject({ emojiLikesList: [] })

    control.updateBot({ id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: true, disabledCapabilities: ['message.emoji-like.list'] })
    await expect(control.bot.internal._request('fetch_emoji_like', { message_id: sent.messageId, emojiId: '128077', emojiType: 2 }))
      .rejects.toThrow('能力已被禁用：message.emoji-like.list')
    // 贴表情是另一项能力，不受这次禁用影响。
    await expect(control.bot.internal._request('set_msg_emoji_like', { message_id: sent.messageId, emoji_id: '128077' }))
      .resolves.toMatchObject({ status: 'ok' })
  })
})
