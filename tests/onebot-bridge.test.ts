import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { h, Universal } from '@satorijs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { MAX_MEDIA_SIZE } from '../src/media-storage'
import { getOneBotMessageSequence } from '../src/onebot-profiles'

const runningApps: App[] = []
const runningServers: Server[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

async function createMediaServer(): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === '/sticker') {
      const content = Buffer.from('remote-sticker')
      response.writeHead(200, {
        'content-type': 'image/png; charset=binary',
        'content-length': String(content.length),
      })
      response.end(content)
      return
    }
    if (request.url === '/text') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('not an image')
      return
    }
    if (request.url === '/too-large') {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(MAX_MEDIA_SIZE + 1),
      })
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  runningServers.push(server)
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function createControl() {
  const app = new App()
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    // 不传 mediaDirectory 时所有测试进程共享仓库内同一媒体目录，而控制服务构造/销毁都会 clear()
    // 该目录，vitest 并行跑测试文件时会互相删掉对方刚写入的媒体文件，造成偶发 ENOENT。
    control = new SandboxControlService(ctx, { mediaDirectory: mkdtempSync(join(tmpdir(), 'onebot-bridge-media-')) })
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  return { app, control }
}

describe('Koishi 与 OneBot 机器人桥接', () => {
  it('后置中间件回复会写回原会话，并保留图片消息段', async () => {
    const { app, control } = await createControl()
    const imageSource = `data:image/png;base64,${Buffer.from('reply-image').toString('base64')}`
    app.middleware((session, next) => next(async (nextMiddleware) => {
      if (session.selfId !== '20001' || session.userId !== '10001') return nextMiddleware?.()
      await session.sendQueued(h.image(imageSource), 0)
    }))

    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '触发机器人回复',
    })

    const messages = control.getSnapshot().messages
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      authorId: '20001',
      conversationId: 'private:10001:20001',
      content: '[图片] image.png',
      media: [expect.objectContaining({
        type: 'image',
        name: 'image.png',
        mimeType: 'image/png',
        reference: expect.stringMatching(/^sandbox-media:\/\//),
      })],
    })
    expect(control.getMediaContent({ operatorId: '10001', mediaId: messages[1].media![0].id })).toMatchObject({
      mimeType: 'image/png',
      dataBase64: Buffer.from('reply-image').toString('base64'),
    })
    await expect(control.bot.internal._request('get_friend_msg_history', {
      user_id: 10001,
      message_seq: 0,
      count: 30,
    })).resolves.toMatchObject({
      data: {
        messages: [
          expect.objectContaining({ message: [{ type: 'text', data: { text: '触发机器人回复' } }] }),
          expect.objectContaining({ message: [{ type: 'image', data: expect.objectContaining({ url: expect.stringMatching(/^sandbox-media:\/\//) }) }] }),
        ],
      },
    })
  })

  it('机器人发送的 execute 组件先执行命令再写入图片结果', async () => {
    const { app, control } = await createControl()
    const imageSource = `data:image/png;base64,${Buffer.from('execute-image').toString('base64')}`
    app.command('sandbox.execute-test').action(() => h.image(imageSource))
    app.middleware((session) => {
      if (session.content === '触发 execute') return '<execute>sandbox.execute-test</execute>'
    })

    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '触发 execute',
    })

    expect(control.getSnapshot().messages).toEqual([
      expect.objectContaining({ content: '触发 execute', authorId: '10001' }),
      expect.objectContaining({
        content: '[图片] image.png',
        authorId: '20001',
        media: [expect.objectContaining({
          type: 'image',
          mimeType: 'image/png',
          reference: expect.stringMatching(/^sandbox-media:\/\//),
        })],
      }),
    ])
  })

  it('Satori 接口认 adapter-onebot 格式的 channelId，也认沙盒会话 ID', async () => {
    const { control } = await createControl()
    const bot = control.bot

    // 插件按真实格式拼 channelId：群聊是裸群号，私聊是 `private:<QQ号>`。
    const [groupMessageId] = await bot.sendMessage('30001', '按群号发')
    const [directMessageId] = await bot.sendMessage('private:10001', '按 QQ 号发')
    await bot.sendMessage('group:30001', '按会话 ID 发')
    // 返回的是 Satori 消息 ID，即十进制的 message_id（NapCat 是消息序号）。
    const bySatoriId = (satoriId: string | undefined) => control.getSnapshot().messages
      .find(({ id }) => String(getOneBotMessageSequence(id)) === satoriId)
    expect(bySatoriId(groupMessageId)?.conversationId).toBe('group:30001')
    expect(bySatoriId(directMessageId)?.conversationId).toBe('private:10001:20001')

    const history = await bot.getMessageList('30001')
    expect(history.data.map(({ content }) => content)).toEqual(['按群号发', '按会话 ID 发'])
    expect(history.data[0]?.channel?.id).toBe('30001')
    await expect(bot.getMessage('private:10001', directMessageId!)).resolves.toMatchObject({ channel: { id: 'private:10001' } })
    await bot.deleteMessage('30001', groupMessageId!)
    expect(bySatoriId(groupMessageId)?.lifecycle?.status).toBe('recalled')

    await expect(bot.sendMessage('39999', '不存在的群')).rejects.toThrow('会话不存在：39999')
    await expect(bot.sendMessage('private:10099', '不是好友')).rejects.toThrow()
  })

  it('群聊消息提供昵称唤醒所需的标准 Session 字段', async () => {
    const { app, control } = await createControl()
    let captured: {
      guildId?: string
      channelId?: string
      isDirect?: boolean
      selfId?: string
      userId?: string
      content?: string
      text?: string
    } | undefined
    app.middleware((session) => {
      if (session.channelId !== '30001') return
      captured = {
        guildId: session.guildId,
        channelId: session.channelId,
        isDirect: session.isDirect,
        selfId: session.selfId,
        userId: session.userId,
        content: session.content,
        text: (session.elements ?? []).filter(({ type }) => type === 'text').map(({ attrs }) => attrs.content ?? '').join(''),
      }
      if (captured.text?.startsWith('宁宁')) return '群聊昵称回复'
    })

    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      content: '宁宁你好',
    })

    expect(captured).toEqual({
      guildId: '30001',
      channelId: '30001',
      isDirect: false,
      selfId: '20001',
      userId: '10001',
      content: '宁宁你好',
      text: '宁宁你好',
    })
    expect(control.getSnapshot().messages.at(-1)).toMatchObject({
      authorId: '20001',
      conversationId: 'group:30001',
      content: '群聊昵称回复',
    })
  })

  it('多个机器人始终使用各自真实 selfId 处理协议事件与 action', async () => {
    const { app, control } = await createControl()
    control.createBot({ id: '20002', name: '第二机器人', implementation: 'llbot', enabled: true })
    const secondBot = control.getRuntimeBot('20002')
    const group = control.getSnapshot().groups[0]
    control.updateGroup({
      id: group.id,
      name: group.name,
      members: [...group.members, { participantId: '20002', role: 'admin' }],
    })
    const received: Array<{ selfId?: string; rawSelfId?: number; messageId?: string }> = []
    app.middleware((session) => {
      received.push({
        selfId: session.selfId,
        rawSelfId: (session as typeof session & { onebot?: { self_id?: number } }).onebot?.self_id,
        messageId: session.messageId,
      })
    })

    expect(secondBot.selfId).toBe('20002')
    await expect(secondBot.internal._request('get_login_info', {})).resolves.toEqual({
      status: 'ok',
      retcode: 0,
      data: { user_id: 20002, nickname: '第二机器人' },
    })
    const sent = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '多机器人事件' })
    // Satori 消息 ID 是十进制的 message_id；NapCat 与 LLBot 都是消息序号。
    expect(received).toEqual(expect.arrayContaining([
      { selfId: '20001', rawSelfId: 20001, messageId: String(getOneBotMessageSequence(sent.messageId)) },
      { selfId: '20002', rawSelfId: 20002, messageId: String(getOneBotMessageSequence(sent.messageId)) },
    ]))

    await secondBot.internal._request('set_qq_profile', { nickname: '第二机器人新昵称' })
    expect(control.getSnapshot().participants.find(({ id }) => id === '20002')).toMatchObject({ name: '第二机器人新昵称' })
    expect(control.getSnapshot().participants.find(({ id }) => id === '20001')).toMatchObject({ name: 'ChatLuna' })

    const privateResult = await secondBot.internal._request('send_private_msg', { user_id: 10001, message: '机器人主动私聊' }) as {
      data: { message_id: number }
    }
    expect(control.getSnapshot().messages.find(({ id }) => getOneBotMessageSequence(id) === privateResult.data.message_id)).toMatchObject({
      authorId: '20002',
      conversationId: 'private:10001:20002',
    })
  })

  it('机器人注册为在线 OneBot Bot，并通过 action 修改共享资料', async () => {
    const { control } = await createControl()
    const bot = control.bot

    expect(bot.platform).toBe('onebot')
    expect(bot.selfId).toBe('20001')
    expect(bot.status).toBe(Universal.Status.ONLINE)
    expect(await bot.internal._request('get_status', {})).toEqual({
      status: 'ok',
      retcode: 0,
      data: { online: true, good: true },
    })
    await expect((bot.internal as unknown as { get_status(): Promise<unknown> }).get_status()).resolves.toMatchObject({ status: 'ok', retcode: 0 })
    expect(await bot.internal._request('get_login_info', {})).toEqual({
      status: 'ok',
      retcode: 0,
      data: { user_id: 20001, nickname: 'ChatLuna' },
    })

    await bot.internal._request('set_qq_profile', { nickname: '新 ChatLuna' })
    await bot.internal._request('set_qq_avatar', { file: `data:image/png;base64,${Buffer.from('koishi-avatar').toString('base64')}` })

    expect(control.getSnapshot().participants.find(({ id }) => id === '20001')).toMatchObject({
      kind: 'bot',
      id: '20001',
      name: '新 ChatLuna',
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
    })
    expect(bot.user).toMatchObject({
      id: '20001',
      name: '新 ChatLuna',
      avatar: `data:image/png;base64,${Buffer.from('koishi-avatar').toString('base64')}`,
    })

    control.updateBot({ id: '20001', name: '新 ChatLuna', implementation: 'napcat', enabled: false })
    await expect(bot.internal._request('get_status', {})).resolves.toMatchObject({ data: { online: false, good: false } })
    await expect(bot.sendPrivateMessage('10001', '离线消息')).rejects.toThrow('机器人已离线')
  })

  it('标准 Koishi 查询与 OneBot 查询读取同一批好友和群资料', async () => {
    const { control } = await createControl()
    const bot = control.bot

    await expect(bot.getUser('10001')).resolves.toMatchObject({ id: '10001', name: '测试用户1', isBot: false })
    await expect(bot.getFriendList()).resolves.toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ user: expect.objectContaining({ id: '10001', name: '测试用户1' }) })]),
    })
    await expect(bot.getGuildList()).resolves.toEqual({ data: [{ id: '30001', name: '测试群' }] })
    await expect(bot.getGuildMember('30001', '10002')).resolves.toMatchObject({
      user: { id: '10002', name: '测试用户2', isBot: false },
      nick: '测试用户2',
      roles: [{ id: 'admin', name: '管理员' }],
    })

    await expect(bot.internal._request('get_friend_list', {})).resolves.toMatchObject({
      status: 'ok',
      retcode: 0,
      data: expect.arrayContaining([expect.objectContaining({ user_id: 10001, nickname: '测试用户1' })]),
    })
    await expect(bot.internal._request('get_group_list', {})).resolves.toEqual({
      status: 'ok',
      retcode: 0,
      data: [{ group_id: 30001, group_name: '测试群', member_count: 4, max_member_count: 4 }],
    })
    await expect(bot.internal.getGroupInfo('group:30001')).resolves.toEqual({
      group_id: 30001,
      group_name: '测试群',
      member_count: 4,
      max_member_count: 4,
    })
    await expect(bot.internal._request('get_group_member_info', { group_id: 30001, user_id: 10002 })).resolves.toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { group_id: 30001, user_id: 10002, nickname: '测试用户2', card: '测试用户2', role: 'admin' },
    })
    await expect(bot.internal.getGroupMemberList('group:30001')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ group_id: 30001, user_id: 10002, role: 'admin' }),
    ]))
    await expect(bot.internal.getGroupMemberInfo('group:30001', 10002)).resolves.toMatchObject({
      group_id: 30001,
      user_id: 10002,
      role: 'admin',
    })
    await expect(bot.internal._request('get_version_info', {})).resolves.toEqual({
      status: 'ok',
      retcode: 0,
      data: { app_name: 'NapCat.Onebot', app_version: 'sandbox-2026.07.24', protocol_version: 'v11' },
    })
  })

  it('标准与原始消息 action 写入、读取并撤回同一共享消息', async () => {
    const { control } = await createControl()
    const bot = control.bot

    const [standardMessageId] = await bot.sendPrivateMessage('10001', '标准私聊消息')
    await expect(bot.getMessage('private:10001:20001', standardMessageId)).resolves.toMatchObject({
      id: standardMessageId,
      content: '标准私聊消息',
      user: { id: '20001', name: 'ChatLuna', isBot: true },
    })

    const privateResult = await bot.internal._request('send_private_msg', { user_id: 10001, message: '原始私聊消息' }) as {
      data: { message_id: number }
    }
    await expect(bot.internal._request('get_msg', { message_id: privateResult.data.message_id })).resolves.toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { message_id: privateResult.data.message_id, message_type: 'private', raw_message: '原始私聊消息' },
    })

    const groupResult = await bot.internal._request('send_group_msg', { group_id: 30001, message: [{ type: 'text', data: { text: '群广播' } }] }) as {
      data: { message_id: number }
    }
    expect(control.getSnapshot().messages.filter(({ content }) => content === '群广播')).toHaveLength(1)

    await bot.internal._request('delete_msg', { message_id: groupResult.data.message_id })
    expect(control.getSnapshot().messages.find(({ id }) => getOneBotMessageSequence(id) === groupResult.data.message_id)).toEqual(expect.objectContaining({
      content: '群广播',
      lifecycle: expect.objectContaining({ status: 'recalled', operatorId: '20001' }),
    }))
    await bot.deleteMessage('private:10001:20001', standardMessageId)
    expect(control.getSnapshot().messages.find(({ id }) => String(getOneBotMessageSequence(id)) === standardMessageId)).toEqual(expect.objectContaining({
      lifecycle: expect.objectContaining({ status: 'recalled', operatorId: '20001' }),
    }))
    await expect(bot.internal._request('get_msg', { message_id: groupResult.data.message_id }))
      .rejects.toThrow(/消息已撤回|消息不存在/)
  })

  it('OneBot 数字 MessageId 支持查询、引用与图片消息闭环', async () => {
    const { control } = await createControl()
    const bot = control.bot
    const imageBase64 = Buffer.from('onebot-image').toString('base64')
    const quoted = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      content: '需要引用的消息',
    })
    const quotedSequence = getOneBotMessageSequence(quoted.messageId)

    await expect(bot.internal._request('get_msg', { message_id: quotedSequence })).resolves.toMatchObject({
      status: 'ok',
      data: { message_id: quotedSequence, raw_message: '需要引用的消息' },
    })

    const groupResult = await bot.internal._request('send_group_msg', {
      group_id: 30001,
      message: [
        { type: 'reply', data: { id: String(quotedSequence) } },
        { type: 'text', data: { text: '带图片的引用回复' } },
        { type: 'image', data: { file: `data:image/png;base64,${imageBase64}` } },
      ],
    }) as { data: { message_id: number } }
    const groupMessage = control.getSnapshot().messages.find(({ id }) => getOneBotMessageSequence(id) === groupResult.data.message_id)
    expect(groupMessage).toMatchObject({
      authorId: '20001',
      conversationId: 'group:30001',
      content: '带图片的引用回复',
      replyToMessageId: quoted.messageId,
      media: [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
    })
    expect(groupMessage?.content).not.toContain('[CQ:image]')
    await expect(bot.internal._request('get_msg', { message_id: groupResult.data.message_id })).resolves.toMatchObject({
      data: {
        message_id: groupResult.data.message_id,
        message: [
          { type: 'reply', data: { id: String(quotedSequence) } },
          { type: 'image', data: expect.objectContaining({ file: expect.stringMatching(/^sandbox-media:\/\//) }) },
          { type: 'text', data: { text: '带图片的引用回复' } },
        ],
      },
    })

    const privateResult = await bot.internal._request('send_private_msg', {
      user_id: 10001,
      message: [{ type: 'image', data: { file: `base64://${imageBase64}` } }],
    }) as { data: { message_id: number } }
    const privateMessage = control.getSnapshot().messages.find(({ id }) => getOneBotMessageSequence(id) === privateResult.data.message_id)
    expect(privateMessage).toMatchObject({
      authorId: '20001',
      conversationId: 'private:10001:20001',
      content: '[图片] image.png',
      media: [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
    })

    const sourceReference = groupMessage?.media?.[0].reference
    expect(sourceReference).toMatch(/^sandbox-media:\/\//)
    const copyResult = await bot.internal._request('send_group_msg', {
      group_id: 30001,
      message: [{ type: 'image', data: { file: sourceReference } }],
    }) as { data: { message_id: number } }
    const copiedMessage = control.getSnapshot().messages.find(({ id }) => getOneBotMessageSequence(id) === copyResult.data.message_id)
    expect(copiedMessage?.media?.[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    // 相同图片内容按内容寻址复用同一媒体 ID，复制发送不会产生额外文件。
    expect(copiedMessage?.media?.[0].id).toBe(groupMessage?.media?.[0].id)

    const [quotedReplyId] = await bot.sendMessage('group:30001', [
      h('quote', { id: quoted.messageId }),
      h.text('标准 Koishi 引用'),
    ])
    expect(control.getSnapshot().messages.find(({ id }) => String(getOneBotMessageSequence(id)) === quotedReplyId)).toMatchObject({
      replyToMessageId: quoted.messageId,
      content: '标准 Koishi 引用',
    })

    const mediaServer = await createMediaServer()
    const remoteResult = await bot.internal._request('send_group_msg', {
      group_id: 30001,
      message: [{ type: 'sticker', data: { url: `${mediaServer}/sticker` } }],
    }) as { data: { message_id: number } }
    const remoteMessage = control.getSnapshot().messages.find(({ id }) => getOneBotMessageSequence(id) === remoteResult.data.message_id)
    expect(remoteMessage).toMatchObject({
      content: '[图片] image.png',
      media: [expect.objectContaining({ type: 'image', mimeType: 'image/png', size: 14 })],
    })
    expect(remoteMessage?.content).not.toContain('[CQ:sticker]')
    const remoteMedia = remoteMessage?.media?.[0]
    if (!remoteMedia) throw new Error('远程表情未写入媒体')
    expect(Buffer.from(control.getMediaContent({ operatorId: '20001', mediaId: remoteMedia.id }).dataBase64, 'base64').toString()).toBe('remote-sticker')
    await expect(bot.internal._request('get_msg', { message_id: remoteResult.data.message_id })).resolves.toMatchObject({
      data: {
        message_id: remoteResult.data.message_id,
        message: [{ type: 'image', data: expect.objectContaining({ file: remoteMedia.reference }) }],
      },
    })

    const beforeFailure = control.getSnapshot().messages.length
    for (const [path, error] of [
      ['/missing', '下载远程媒体失败'],
      ['/text', '媒体类型不匹配'],
      ['/too-large', '媒体大小不能超过 10 MB'],
    ] as const) {
      await expect(bot.internal._request('send_group_msg', {
        group_id: 30001,
        message: [{ type: 'image', data: { file: `${mediaServer}${path}` } }],
      })).rejects.toThrow(error)
      expect(control.getSnapshot().messages).toHaveLength(beforeFailure)
    }
  })

  it('机器人通过标准方法和 OneBot action 处理申请与群管理', async () => {
    const { control } = await createControl()
    const bot = control.bot
    control.createUser({ id: '10004', name: '申请用户' })
    await control.performFriendAction({ action: 'delete', operatorId: '10004', targetId: '20001' })
    const friendRequest = await control.performFriendAction({ action: 'request', operatorId: '10004', targetId: '20001' })
    if (!friendRequest.requestId) throw new Error('好友申请未创建')

    await bot.handleFriendRequest(friendRequest.requestId, true, '申请用户')
    expect(control.getSnapshot().friendships.some(({ participantIds }) => participantIds.includes('10004') && participantIds.includes('20001'))).toBe(true)

    const groupRequest = await control.performGroupAction({ action: 'request-join', operatorId: '10004', groupId: '30001' })
    if (!groupRequest.requestId) throw new Error('入群申请未创建')
    await bot.handleGuildMemberRequest(groupRequest.requestId, true)
    expect(control.getSnapshot().groups[0].members).toContainEqual({ participantId: '10004', role: 'member' })

    await bot.internal._request('set_group_card', { group_id: 30001, user_id: 10003, card: '新成员名片' })
    await bot.internal._request('set_group_name', { group_id: 30001, group_name: '机器人管理群' })
    expect(control.getSnapshot().groups[0]).toMatchObject({
      name: '机器人管理群',
      members: expect.arrayContaining([expect.objectContaining({ participantId: '10003', card: '新成员名片' })]),
    })

    await bot.kickGuildMember('30001', '10003')
    expect(control.getSnapshot().groups[0].members.some(({ participantId }) => participantId === '10003')).toBe(false)
  })

  it('关系和成员变化同时产生标准 Koishi 事件与 OneBot 原始数据', async () => {
    const { app, control } = await createControl()
    const standardEvents: Array<{ type?: string; userId?: string; guildId?: string; rawType?: string }> = []
    const rawNotices: string[] = []
    const listen = (name: string) => {
      ;(app.on as unknown as (name: string, listener: (session: unknown) => void) => void)(name, (session) => {
        const value = session as { type?: string; userId?: string; guildId?: string; onebot?: { notice_type?: string; request_type?: string } }
        standardEvents.push({
          type: value.type,
          userId: value.userId,
          guildId: value.guildId,
          rawType: value.onebot?.notice_type ?? value.onebot?.request_type,
        })
      })
    }
    for (const name of ['friend-request', 'guild-member-request', 'guild-member-added', 'guild-member-updated', 'guild-updated', 'guild-member-removed']) listen(name)
    ;(app.on as unknown as (name: string, listener: (session: unknown) => void) => void)('notice', (session) => {
      const value = session as { onebot?: { notice_type?: string } }
      if (value.onebot?.notice_type) rawNotices.push(value.onebot.notice_type)
    })

    control.createUser({ id: '10004', name: '申请用户' })
    await control.performFriendAction({ action: 'delete', operatorId: '10004', targetId: '20001' })
    await control.performFriendAction({ action: 'request', operatorId: '10004', targetId: '20001' })
    const groupRequest = await control.performGroupAction({ action: 'request-join', operatorId: '10004', groupId: '30001' })
    if (!groupRequest.requestId) throw new Error('入群申请未创建')
    await control.bot.handleGuildMemberRequest(groupRequest.requestId, true)
    await control.bot.internal._request('set_group_card', { group_id: 30001, user_id: 10003, card: '新名片' })
    await control.bot.internal._request('set_group_name', { group_id: 30001, group_name: '新群名称' })
    await control.bot.kickGuildMember('30001', '10003')

    expect(standardEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'friend-request', userId: '10004', rawType: 'friend' }),
      expect.objectContaining({ type: 'guild-member-request', userId: '10004', guildId: '30001', rawType: 'group' }),
      expect.objectContaining({ type: 'guild-member-added', userId: '10004', guildId: '30001', rawType: 'group_increase' }),
      expect.objectContaining({ type: 'guild-member-updated', userId: '10003', guildId: '30001', rawType: 'group_card' }),
      expect.objectContaining({ type: 'guild-updated', guildId: '30001', rawType: 'group_name' }),
      expect.objectContaining({ type: 'guild-member-removed', userId: '10003', guildId: '30001', rawType: 'group_decrease' }),
    ]))
    expect(rawNotices).toEqual(expect.arrayContaining(['group_increase', 'group_card', 'group_name', 'group_decrease']))
  })

  it('申请事件与 adapter-onebot 同形：flag 在 messageId、附言在 content，插件凭它们就能处理申请', async () => {
    const { app, control } = await createControl()
    type RequestSession = {
      type?: string
      messageId?: string
      content?: string
      userId?: string
      guildId?: string
      channelId?: string
      bot: { handleFriendRequest(id: string, approve: boolean): Promise<void>; handleGuildRequest(id: string, approve: boolean): Promise<void>; handleGuildMemberRequest(id: string, approve: boolean): Promise<void> }
    }
    const received: RequestSession[] = []
    for (const name of ['friend-request', 'guild-request', 'guild-member-request']) {
      ;(app.on as unknown as (name: string, listener: (session: RequestSession) => void) => void)(name, (session) => {
        received.push(session)
      })
    }

    control.createUser({ id: '10004', name: '申请用户' })
    await control.performFriendAction({ action: 'delete', operatorId: '10004', targetId: '20001' })
    const friend = await control.performFriendAction({ action: 'request', operatorId: '10004', targetId: '20001', comment: '加个好友' })
    const join = await control.performGroupAction({ action: 'request-join', operatorId: '10004', groupId: '30001', comment: '想进群' })
    control.createGroup({ id: '30030', name: '邀请群', members: [{ participantId: '10001', role: 'owner' }] })
    const invite = await control.performGroupAction({ action: 'invite', operatorId: '10001', groupId: '30030', targetId: '20001', comment: '来玩' })

    expect(received.map(({ type, messageId, content, userId, guildId, channelId }) => ({ type, messageId, content, userId, guildId, channelId }))).toEqual([
      { type: 'friend-request', messageId: friend.requestId, content: '加个好友', userId: '10004', guildId: undefined, channelId: 'private:10004' },
      { type: 'guild-member-request', messageId: join.requestId, content: '想进群', userId: '10004', guildId: '30001', channelId: '30001' },
      { type: 'guild-request', messageId: invite.requestId, content: '来玩', userId: '10001', guildId: '30030', channelId: '30030' },
    ])

    // 像 toolbox 这类插件一样只用标准字段处理申请。
    for (const session of received) {
      if (session.type === 'friend-request') await session.bot.handleFriendRequest(session.messageId!, true)
      else if (session.type === 'guild-member-request') await session.bot.handleGuildMemberRequest(session.messageId!, true)
      else await session.bot.handleGuildRequest(session.messageId!, true)
    }
    const scene = control.getSnapshot()
    expect(scene.requests.filter(({ status }) => status === 'pending')).toEqual([])
    expect(scene.groups.find(({ id }) => id === '30001')?.members.map(({ participantId }) => participantId)).toContain('10004')
    expect(scene.groups.find(({ id }) => id === '30030')?.members.map(({ participantId }) => participantId)).toContain('20001')
  })

  it('NapCat 扩展群管理与合并转发 action 走沙盒域逻辑', async () => {
    const { control } = await createControl()
    const bot = control.bot
    control.createGroup({ id: '30002', name: '扩展测试群', members: [
      { participantId: '10001', role: 'owner' },
      { participantId: '20001', role: 'admin' },
      { participantId: '10003', role: 'member' },
    ] })

    await expect(bot.internal._request('set_group_ban', { group_id: 30002, user_id: 10003, duration: 600 })).resolves.toMatchObject({ status: 'ok' })
    await expect(bot.internal._request('set_group_special_title', { group_id: 30002, user_id: 10003, special_title: '头衔' })).rejects.toThrow('只有群主可以设置专属头衔')

    const sent = await bot.internal._request('send_group_msg', { group_id: 30002, message: '表情回应目标' }) as { data: { message_id: number } }
    await expect(bot.internal._request('set_msg_emoji_like', { message_id: sent.data.message_id, emoji_id: '128077' })).resolves.toMatchObject({ status: 'ok' })

    const forward = await bot.internal._request('send_forward_msg', { group_id: 30002, messages: [
      { type: 'node', data: { user_id: 20001, nickname: 'ChatLuna', content: '第一段' } },
      { type: 'node', data: { user_id: 20001, nickname: 'ChatLuna', content: [{ type: 'text', data: { text: '第二段' } }] } },
    ] }) as { data: { message_id: number; res_id: string; forward_id: string } }
    expect(forward.data.res_id).toBe(forward.data.forward_id)
    expect(control.getSnapshot().messages.at(-1)).toMatchObject({
      authorId: '20001',
      forwardId: forward.data.forward_id,
      content: 'ChatLuna：第一段\nChatLuna：第二段',
    })
    expect(control.getSnapshot().forwards).toContainEqual(expect.objectContaining({
      id: forward.data.forward_id,
      nodes: [
        expect.objectContaining({ userId: '20001', nickname: 'ChatLuna', content: '第一段' }),
        expect.objectContaining({ userId: '20001', nickname: 'ChatLuna', content: '第二段' }),
      ],
    }))

    await expect(bot.internal._request('set_group_leave', { group_id: 30002 })).resolves.toMatchObject({ status: 'ok' })
    expect(control.getSnapshot().groups.find(({ id }) => id === '30002')!.members.some(({ participantId }) => participantId === '20001')).toBe(false)
  })

  it('合并转发创建真实资源并支持 get_forward_msg / 引用节点 / 别名 action', async () => {
    const { control } = await createControl()
    const bot = control.bot
    control.createGroup({ id: '30020', name: '合并转发群', members: [
      { participantId: '10001', role: 'owner' },
      { participantId: '20001', role: 'admin' },
      { participantId: '10003', role: 'member' },
    ] })
    const first = await bot.internal._request('send_group_msg', {
      group_id: 30020,
      message: '引用节点 A',
    }) as { data: { message_id: number } }
    const second = await bot.internal._request('send_group_msg', {
      group_id: 30020,
      message: '引用节点 B',
    }) as { data: { message_id: number } }

    const mixed = await bot.internal._request('send_group_forward_msg', {
      group_id: 30020,
      messages: [
        { type: 'node', data: { id: first.data.message_id } },
        { type: 'node', data: { user_id: 10003, nickname: '自定义昵称', content: '自定义节点' } },
        { type: 'node', data: { id: second.data.message_id } },
      ],
    }) as { data: { message_id: number; res_id: string; forward_id: string } }
    expect(mixed.data.forward_id).toBeTruthy()
    expect(mixed.data.res_id).toBe(mixed.data.forward_id)
    // 含自定义节点的转发不写标题，卡片沿用默认的「群聊的聊天记录」。
    expect(control.getForwardMessage({ operatorId: '10001', forwardId: mixed.data.forward_id }).title).toBeUndefined()

    // ChatLuna 的 OneBot 插件经适配器的 internal._get 读取转发：只返回 data，调试记录按真实 action 名记账。
    const viaGet = await bot.internal._get('get_forward_msg', { message_id: mixed.data.forward_id, id: mixed.data.forward_id }) as {
      messages: unknown[]
    }
    expect(viaGet.messages).toHaveLength(3)
    expect((await control.getOneBotDebugStore().getRecords({ direction: 'action' })).records[0]).toMatchObject({
      requestedAction: 'get_forward_msg',
      action: 'get_forward_msg',
      status: 'success',
    })

    const outer = await bot.internal._request('get_msg', { message_id: mixed.data.message_id }) as {
      data: { message: Array<{ type: string; data: Record<string, string> }> }
    }
    expect(outer.data.message).toEqual([{ type: 'forward', data: { id: mixed.data.forward_id } }])

    const byId = await bot.internal._request('get_forward_msg', { id: mixed.data.forward_id }) as {
      data: { messages: Array<{ type: string; data: Record<string, unknown> }> }
    }
    expect(byId.data.messages).toHaveLength(3)
    expect(byId.data.messages[0]).toMatchObject({
      type: 'node',
      data: {
        user_id: 20001,
        content: [{ type: 'text', data: { text: '引用节点 A' } }],
      },
    })
    expect(byId.data.messages[1]).toMatchObject({
      type: 'node',
      data: {
        user_id: 10003,
        nickname: '自定义昵称',
        content: [{ type: 'text', data: { text: '自定义节点' } }],
      },
    })

    const byMessageId = await bot.internal._request('get_forward_msg', {
      message_id: mixed.data.message_id,
    }) as { data: { nodes: Array<{ type: string }> } }
    expect(byMessageId.data.nodes).toHaveLength(3)

    const privateForward = await bot.internal._request('send_private_forward_msg', {
      user_id: 10001,
      messages: [
        { type: 'node', data: { user_id: 20001, nickname: 'ChatLuna', content: '私聊转发' } },
      ],
    }) as { data: { message_id: number; forward_id: string } }
    expect(control.getSnapshot().messages.find(({ id }) => getOneBotMessageSequence(id) === privateForward.data.message_id)).toMatchObject({
      conversationId: 'private:10001:20001',
      forwardId: privateForward.data.forward_id,
    })

    // 嵌套 forward：自定义节点 content 直接挂已有资源。
    const nested = await bot.internal._request('send_forward_msg', {
      group_id: 30020,
      messages: [
        { type: 'node', data: { user_id: 20001, nickname: 'ChatLuna', content: [{ type: 'forward', data: { id: mixed.data.forward_id } }] } },
      ],
    }) as { data: { forward_id: string } }
    const nestedDetail = await bot.internal._request('get_forward_msg', { id: nested.data.forward_id }) as {
      data: { messages: Array<{ data: { content: Array<{ type: string; data: { id: string } }> } }> }
    }
    expect(nestedDetail.data.messages[0].data.content).toEqual([
      { type: 'forward', data: { id: mixed.data.forward_id } },
    ])
    await expect(bot.internal._request('get_forward_msg', { id: mixed.data.forward_id })).resolves.toMatchObject({
      data: { messages: expect.any(Array) },
    })

    // 自定义节点同时带文字与嵌套转发时两者都保留：读回的节点、外层消息摘要都不丢文字。
    const annotated = await bot.internal._request('send_forward_msg', {
      group_id: 30020,
      messages: [
        { type: 'node', data: { user_id: 20001, nickname: 'ChatLuna', content: [{ type: 'text', data: { text: '附言' } }, { type: 'forward', data: { id: mixed.data.forward_id } }] } },
      ],
    }) as { data: { message_id: number; forward_id: string } }
    const annotatedDetail = await bot.internal._request('get_forward_msg', { id: annotated.data.forward_id }) as {
      data: { messages: Array<{ data: { content: Array<{ type: string; data: Record<string, string> }> } }> }
    }
    expect(annotatedDetail.data.messages[0].data.content).toEqual([
      { type: 'text', data: { text: '附言' } },
      { type: 'forward', data: { id: mixed.data.forward_id } },
    ])
    expect(control.getSnapshot().messages.find(({ id }) => getOneBotMessageSequence(id) === annotated.data.message_id)?.content)
      .toBe('ChatLuna：附言 [合并转发]')

    // 自定义节点媒体支持 data URI，落盘后可被 get_forward_msg 读回。
    const imagePayload = Buffer.from('forward-node-image').toString('base64')
    const mediaForward = await bot.internal._request('send_forward_msg', {
      group_id: 30020,
      messages: [{
        type: 'node',
        data: {
          user_id: 20001,
          nickname: 'ChatLuna',
          content: [{
            type: 'image',
            data: { file: `data:image/png;base64,${imagePayload}`, name: 'forward-node.png' },
          }],
        },
      }],
    }) as { data: { forward_id: string } }
    const mediaDetail = await bot.internal._request('get_forward_msg', { id: mediaForward.data.forward_id }) as {
      data: { messages: Array<{ data: { content: Array<{ type: string; data: Record<string, string> }> } }> }
    }
    expect(mediaDetail.data.messages[0].data.content).toEqual([
      expect.objectContaining({
        type: 'image',
        data: expect.objectContaining({
          file: expect.stringMatching(/^sandbox-media:\/\//),
          url: expect.stringMatching(/^sandbox-media:\/\//),
        }),
      }),
    ])
    const storedMediaId = mediaDetail.data.messages[0].data.content[0].data.file.replace('sandbox-media://', '')
    expect(control.getMediaContent({
      operatorId: '20001',
      mediaId: storedMediaId,
    })).toMatchObject({
      mimeType: 'image/png',
      dataBase64: imagePayload,
    })
  })

  it('合并转发拒绝不可见/事件/撤回消息，并遵守能力禁用', async () => {
    const { control } = await createControl()
    const bot = control.bot
    control.createGroup({ id: '30021', name: '权限群', members: [
      { participantId: '10001', role: 'owner' },
      { participantId: '20001', role: 'admin' },
    ] })
    control.createUser({ id: '10088', name: '外人' })
    control.createBot({ id: '20088', name: '外人机器人', implementation: 'napcat', enabled: true })
    control.createGroup({ id: '30022', name: '外人群', members: [
      { participantId: '10088', role: 'owner' },
      { participantId: '20088', role: 'member' },
    ] })

    const hidden = await control.getRuntimeBot('20088').internal._request('send_group_msg', {
      group_id: 30022,
      message: '外人消息',
    }) as { data: { message_id: number } }
    await expect(bot.internal._request('send_forward_msg', {
      group_id: 30021,
      messages: [{ type: 'node', data: { id: hidden.data.message_id } }],
    })).rejects.toThrow(/消息不存在|不能合并转发/)

    await control.performFriendAction({
      action: 'poke',
      operatorId: '10001',
      targetId: '20001',
      conversationId: 'private:10001:20001',
    })
    const poke = control.getSnapshot().messages.find(({ event }) => event?.type === 'poke')!
    await expect(bot.internal._request('send_private_forward_msg', {
      user_id: 10001,
      messages: [{ type: 'node', data: { id: poke.id } }],
    })).rejects.toThrow('事件消息不能合并转发')

    const sent = await bot.internal._request('send_group_msg', {
      group_id: 30021,
      message: '即将撤回',
    }) as { data: { message_id: number } }
    await bot.internal._request('delete_msg', { message_id: sent.data.message_id })
    await expect(bot.internal._request('send_group_forward_msg', {
      group_id: 30021,
      messages: [{ type: 'node', data: { id: sent.data.message_id } }],
    })).rejects.toThrow(/撤回|消息已撤回/)

    control.updateBot({
      id: '20001',
      name: 'ChatLuna',
      implementation: 'napcat',
      enabled: true,
      disabledCapabilities: ['message.forward.send'],
    })
    await expect(bot.internal._request('send_forward_msg', {
      group_id: 30021,
      messages: [{ type: 'node', data: { user_id: 20001, nickname: 'ChatLuna', content: '禁用后' } }],
    })).rejects.toThrow(/不支持|disabled|禁用|message\.forward\.send|send_forward_msg/i)
  })

  it('群头衔、禁言与表情回应写入沙盒领域状态', async () => {
    const { control } = await createControl()
    const bot = control.bot
    control.createGroup({ id: '30003', name: '状态测试群', members: [
      { participantId: '20001', role: 'owner' },
      { participantId: '10001', role: 'admin' },
      { participantId: '10003', role: 'member' },
    ] })
    const getMember = (participantId: string) => control.getSnapshot().groups
      .find(({ id }) => id === '30003')!.members.find((member) => member.participantId === participantId)!

    await expect(bot.internal._request('set_group_special_title', { group_id: 30003, user_id: 10003, special_title: '荣誉成员' }))
      .resolves.toMatchObject({ status: 'ok' })
    expect(getMember('10003').title).toBe('荣誉成员')
    await expect(bot.internal._request('get_group_member_info', { group_id: 30003, user_id: 10003 }))
      .resolves.toMatchObject({ data: { title: '荣誉成员', shut_up_timestamp: 0 } })
    await bot.internal._request('set_group_special_title', { group_id: 30003, user_id: 10003, special_title: '' })
    expect(getMember('10003').title).toBeUndefined()

    await bot.internal._request('set_group_ban', { group_id: 30003, user_id: 10003, duration: 600 })
    const shutList = await bot.internal._request('get_group_shut_list', { group_id: 30003 }) as {
      data: Array<{ uin: string; shutUpTime: number }>
    }
    expect(shutList.data).toHaveLength(1)
    expect(shutList.data[0].uin).toBe('10003')
    expect(shutList.data[0].shutUpTime).toBeGreaterThan(Math.floor(Date.now() / 1000))
    await bot.internal._request('set_group_ban', { group_id: 30003, user_id: 10003, duration: 0 })
    await expect(bot.internal._request('get_group_shut_list', { group_id: 30003 })).resolves.toMatchObject({ data: [] })

    const sent = await bot.internal._request('send_group_msg', { group_id: 30003, message: '回应目标' }) as { data: { message_id: number } }
    await bot.internal._request('set_msg_emoji_like', { message_id: sent.data.message_id, emoji_id: '128077' })
    expect(control.getSnapshot().messages.at(-1)!.reactions).toEqual([{ emojiId: '128077', participantIds: ['20001'] }])
    await bot.internal._request('set_msg_emoji_like', { message_id: sent.data.message_id, emoji_id: '128077', set: false })
    expect(control.getSnapshot().messages.at(-1)!.reactions).toBeUndefined()
  })

  it('专属头衔只有群主可以授予且随场景替换保留', async () => {
    const { control } = await createControl()
    control.createGroup({ id: '30004', name: '头衔权限群', members: [
      { participantId: '10001', role: 'owner' },
      { participantId: '20001', role: 'admin' },
      { participantId: '10003', role: 'member' },
    ] })

    await expect(control.bot.internal._request('set_group_special_title', { group_id: 30004, user_id: 10003, special_title: '头衔' }))
      .rejects.toThrow('只有群主可以设置专属头衔')

    await control.performGroupAction({ action: 'set-title', operatorId: '10001', groupId: '30004', targetId: '10003', title: ' 元老 ' })
    const snapshot = control.getSnapshot()
    expect(snapshot.groups.find(({ id }) => id === '30004')!.members
      .find(({ participantId }) => participantId === '10003')!.title).toBe('元老')

    control.replaceScene(snapshot)
    expect(control.getSnapshot().groups.find(({ id }) => id === '30004')!.members
      .find(({ participantId }) => participantId === '10003')!.title).toBe('元老')
  })

  it('Satori sendMessage 按真实适配器的 send_*_msg 形态记入调试记录', async () => {
    const { control } = await createControl()

    const [messageId] = await control.bot.sendMessage('30001', '经 Satori 发出的群消息')
    const { records } = await control.getOneBotDebugStore().getRecords({ direction: 'action' })
    // 返回的 Satori 消息 ID 与 adapter-onebot 一样是 message_id 的十进制字符串。
    expect(records[0]).toMatchObject({
      requestedAction: 'sendMessage',
      action: 'send_group_msg',
      status: 'success',
      payload: { channel_id: '30001', message: '经 Satori 发出的群消息' },
      result: { retcode: 0, data: { message_id: Number(messageId) } },
    })
  })

  it('私聊频道与 adapter-onebot 一样是 private:<账号>，经 sendPrivateMessage 发出时调试记录同样如此', async () => {
    const { control } = await createControl()

    await expect(control.bot.createDirectChannel('10001')).resolves.toEqual({ id: 'private:10001', type: 1 })
    await expect(control.bot.sendPrivateMessage('99999', '不可见')).rejects.toThrow()
    await control.bot.sendPrivateMessage('10001', '唤醒后的私聊回复')
    const { records } = await control.getOneBotDebugStore().getRecords({ direction: 'action' })
    expect(records[0]).toMatchObject({
      action: 'send_private_msg',
      payload: { channel_id: 'private:10001', message: '唤醒后的私聊回复' },
    })
  })

  it('camelCase 便捷方法映射到真实 OneBot action 而不是未知 action', async () => {
    const { control } = await createControl()

    await expect(control.bot.internal.getGroupInfo(30001)).resolves.toMatchObject({
      group_id: 30001,
      group_name: '测试群',
    })
    expect((await control.getOneBotDebugStore().getRecords({ direction: 'action' })).records[0]).toMatchObject({
      requestedAction: 'get_group_info',
      action: 'get_group_info',
      status: 'success',
    })
  })
})

describe('插件视角的继承前缀', () => {
  /** 一条根会话消息，加上从它分叉出来的分支。 */
  function branchFrom(control: SandboxControlService, rootConversationId: string, messageId: string) {
    return control.branchConversationInstance({
      operatorId: '10001',
      conversationId: rootConversationId,
      messageId,
    }).conversationId
  }

  /** 往根会话发一条消息，再从它分叉出一个分支。 */
  async function createBranch(control: SandboxControlService, rootConversationId: string) {
    const inherited = await control.sendMessage({
      operatorId: '10001',
      conversationId: rootConversationId,
      content: '分叉点那句话',
    })
    return { inherited, conversationId: branchFrom(control, rootConversationId, inherited.messageId) }
  }

  it('插件在群分支里按消息 ID 读到继承前缀，私聊或群聊信息仍是群聊', async () => {
    const { control } = await createControl()
    const bot = control.bot
    const { inherited, conversationId } = await createBranch(control, 'group:30001')

    // 声明了会话的单条读取按「在那个会话里可读」判定：继承前缀仍然归属根会话，
    // 按归属比对会让插件在分支里按 ID 取历史莫名失败。
    // 返回的 id 是 Satori 消息 ID，即十进制的 message_id；按沙盒消息 ID 或 message_id 都读得到。
    const satoriId = String(getOneBotMessageSequence(inherited.messageId))
    await expect(bot.getMessage(conversationId, inherited.messageId)).resolves.toMatchObject({
      id: satoriId,
      content: '分叉点那句话',
    })
    const bySequence = await bot.getMessage(conversationId, satoriId)
    expect(bySequence.id).toBe(satoriId)
    // 类型与群号由消息实体的会话解释，实例的两者都继承根会话：群分支里的继承前缀仍是群聊。
    expect(bySequence.channel?.type).toBe(Universal.Channel.Type.TEXT)
    expect(bySequence.guild?.id).toBe('30001')
    await expect(bot.internal._request('get_msg', { message_id: getOneBotMessageSequence(inherited.messageId) }))
      .resolves.toMatchObject({ data: { message_type: 'group', group_id: 30001 } })
  })

  it('插件通过原始 OneBot 撤回继承前缀生效，分支里随之显示为已撤回', async () => {
    const { control } = await createControl()
    const bot = control.bot
    const sent = await bot.internal._request('send_private_msg', {
      user_id: 10001,
      message: '机器人说的那句话',
    }) as { data: { message_id: number } }
    const forkPointId = control.getSnapshot().messages
      .find(({ id }) => getOneBotMessageSequence(id) === sent.data.message_id)!.id
    const conversationId = branchFrom(control, 'private:10001:20001', forkPointId)
    await control.sendMessage({ operatorId: '10001', conversationId, content: '换一种问法' })

    // 只读约束的是用户在分支视图里的入口，不是消息实体的生命周期：插件寻址的是根会话里的
    // 一条普通消息，拒绝会让沙盒表现出真实环境不存在的错误。
    await expect(bot.internal._request('delete_msg', { message_id: sent.data.message_id }))
      .resolves.toMatchObject({ status: 'ok' })

    // 它本来就是同一条消息，因此分支里如实反映已撤回，而不是留着一份旧快照。
    expect(control.getMessageHistory({ operatorId: '10001', conversationId }).messages
      .map(({ content, lifecycle }) => ({ content, status: lifecycle?.status })))
      .toEqual([
        { content: '机器人说的那句话', status: 'recalled' },
        { content: '换一种问法', status: undefined },
      ])
  })

  it('插件在分支里引用继承前缀回复时，回复落在分支里并指向同一条来源消息', async () => {
    const { app, control } = await createControl()
    const { inherited, conversationId } = await createBranch(control, 'private:10001:20001')
    // 插件拿到的是事件里的 message_seq，用它引用分界线以上那句话继续追问。
    app.middleware((session, next) => {
      if (session.content !== '换一种问法') return next()
      return session.send([
        h('quote', { id: String(getOneBotMessageSequence(inherited.messageId)) }),
        h.text('接着这句问'),
      ])
    })

    await control.sendMessage({ operatorId: '10001', conversationId, content: '换一种问法' })

    const reply = control.getSnapshot().messages.find(({ content }) => content === '接着这句问')
    expect(reply).toMatchObject({ conversationId, replyToMessageId: inherited.messageId })
    // 回复落在分支里，原会话一条都没多。
    expect(control.getSnapshot().conversations.find(({ id }) => id === 'private:10001:20001')!.messageIds)
      .toEqual([inherited.messageId])
  })

  it('声明会话的读取仍然只认在那个会话里可读的消息', async () => {
    const { control } = await createControl()
    const bot = control.bot
    const { conversationId } = await createBranch(control, 'private:10001:20001')
    const own = await control.sendMessage({ operatorId: '10001', conversationId, content: '分支自有的一条' })
    const afterFork = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '分叉点之后的一条',
    })

    // 放宽的只是「按归属比对」这一维，会话仍然是读取范围：分叉点之后的原会话消息不属于这条
    // 分支的继承前缀，反向的分支自有消息在根会话里同样读不到。两条消息本身都对机器人可见，
    // 因此这里被拒的原因只能是会话范围。
    await expect(bot.getMessage(conversationId, afterFork.messageId)).rejects.toThrow(`消息不存在：${afterFork.messageId}`)
    await expect(bot.getMessage('private:10001:20001', own.messageId)).rejects.toThrow(`消息不存在：${own.messageId}`)
    // 同一批消息在它们各自可读的会话里照常读得到。
    await expect(bot.getMessage('private:10001:20001', afterFork.messageId)).resolves.toMatchObject({ id: String(getOneBotMessageSequence(afterFork.messageId)) })
    await expect(bot.getMessage(conversationId, own.messageId)).resolves.toMatchObject({ id: String(getOneBotMessageSequence(own.messageId)) })

    // 出站消息的引用目标走同一处判定：机器人不能在分支里引用分叉点之后的原会话消息。
    await expect(bot.sendMessage(conversationId, [
      h('quote', { id: String(getOneBotMessageSequence(afterFork.messageId)) }),
      h.text('引用分叉点之后的消息'),
    ])).rejects.toThrow(`消息不存在：${getOneBotMessageSequence(afterFork.messageId)}`)
  })

  it('插件在分支里读历史与根会话共用一套游标语义，能连续读到继承部分', async () => {
    const { control } = await createControl()
    const bot = control.bot
    for (const content of ['根一', '根二', '根三']) {
      await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content })
    }
    const forkPointId = control.getSnapshot().conversations
      .find(({ id }) => id === 'private:10001:20001')!.messageIds.at(-1)!
    const conversationId = branchFrom(control, 'private:10001:20001', forkPointId)
    await control.sendMessage({ operatorId: '10001', conversationId, content: '分支一' })

    // 同一段插件代码读两种会话：分支多出的只是自有消息，分界处不断开也不重复。
    const readHistory = async (channelId: string) => (await bot.getMessageList(channelId)).data
      .map(({ content }) => content)
    await expect(readHistory('private:10001:20001')).resolves.toEqual(['根一', '根二', '根三'])
    await expect(readHistory(conversationId)).resolves.toEqual(['根一', '根二', '根三', '分支一'])

    // 游标仍是消息 ID 派生的 message_seq：在分支里读到的那条继承前缀，其游标在历史查询里
    // 照常可用，插件不需要为分支准备第二套取历史的代码。
    const cursor = Number((await bot.getMessage(conversationId, forkPointId)).id)
    await expect(bot.internal._request('get_friend_msg_history', {
      user_id: 10001,
      message_seq: cursor,
      count: 2,
    })).resolves.toMatchObject({
      data: {
        messages: [
          expect.objectContaining({ message: [{ type: 'text', data: { text: '根一' } }] }),
          expect.objectContaining({ message: [{ type: 'text', data: { text: '根二' } }] }),
        ],
      },
    })
  })
})
