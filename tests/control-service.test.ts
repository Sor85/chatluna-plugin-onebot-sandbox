import { App } from './helpers/app'
import { Universal } from '@satorijs/core'
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { getOneBotMessageSequence } from '../src/onebot-profiles'

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('模拟 QQ 环境消息闭环', () => {
  it('发送图片时只在场景保存安全引用，并生成 Koishi 与 OneBot 媒体消息', async () => {
    const app = new App()
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-media-'))
    temporaryDirectories.push(mediaDirectory)
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx, { mediaDirectory })
    })
    runningApps.push(app)

    let receivedSession: {
      content?: string
      elementType?: string
      elementSource?: unknown
      elementUrl?: unknown
      rawMessage?: Array<{ type: string, data: Record<string, string> }>
    } | undefined
    app.middleware((session) => {
      const onebot = (session as typeof session & {
        onebot?: { message?: Array<{ type: string, data: Record<string, string> }> }
      }).onebot
      receivedSession = {
        content: session.content,
        elementType: session.elements?.[0]?.type,
        elementSource: session.elements?.[0]?.attrs.src,
        elementUrl: session.elements?.[0]?.attrs.url,
        rawMessage: onebot?.message,
      }
    })
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    const result = await control.sendMediaMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      media: [{
        fileName: '测试图片.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('image-content').toString('base64'),
      }],
    })

    const message = control.getSnapshot().messages.find(({ id }) => id === result.messageId)
    expect(message).toEqual(expect.objectContaining({
      content: '[图片] 测试图片.png',
      media: [expect.objectContaining({
        type: 'image',
        name: '测试图片.png',
        mimeType: 'image/png',
        size: 13,
        reference: expect.stringMatching(/^sandbox-media:\/\//),
      })],
    }))
    expect(JSON.stringify(control.getSnapshot())).not.toContain('aW1hZ2UtY29udGVudA==')
    expect(receivedSession).toEqual(expect.objectContaining({
      content: expect.stringContaining('<img'),
      elementType: 'img',
      elementSource: expect.stringMatching(/^data:image\/png;base64,aW1hZ2UtY29udGVudA==$/),
      elementUrl: expect.stringMatching(/^data:image\/png;base64,aW1hZ2UtY29udGVudA==$/),
      rawMessage: [{ type: 'image', data: { file: message?.media?.[0].reference } }],
    }))
    expect(control.getBotDeliveries()).toEqual([
      expect.objectContaining({ recipientBotId: '20001', messageId: result.messageId }),
    ])
    expect(control.getMediaContent({
      operatorId: '10001',
      mediaId: message?.media?.[0].id ?? '',
    }).dataBase64).toBe('aW1hZ2UtY29udGVudA==')
    await unlink(join(mediaDirectory, message?.media?.[0].id ?? ''))
    expect(() => control!.getMediaContent({
      operatorId: '10001',
      mediaId: message?.media?.[0].id ?? '',
    })).toThrow('媒体文件不存在')
  })

  it('一条消息携带多个附件与文本，按附件在前文本在后派发', async () => {
    const app = new App()
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-media-'))
    temporaryDirectories.push(mediaDirectory)
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx, { mediaDirectory })
    })
    runningApps.push(app)

    let rawMessage: Array<{ type: string, data: Record<string, string> }> | undefined
    app.middleware((session) => {
      rawMessage = (session as typeof session & {
        onebot?: { message?: Array<{ type: string, data: Record<string, string> }> }
      }).onebot?.message
    })
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    const result = await control.sendMediaMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '两个附件',
      media: [
        { fileName: '图.png', mimeType: 'image/png', dataBase64: Buffer.from('a').toString('base64') },
        { fileName: '档.txt', mimeType: 'text/plain', dataBase64: Buffer.from('b').toString('base64') },
      ],
    })

    const message = control.getSnapshot().messages.find(({ id }) => id === result.messageId)
    expect(message?.content).toBe('两个附件')
    expect(message?.media?.map(({ type }) => type)).toEqual(['image', 'file'])
    expect(rawMessage?.map(({ type }) => type)).toEqual(['image', 'file', 'text'])
  })

  it('拒绝不支持或超限的媒体内容', async () => {
    const app = new App()
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-media-'))
    temporaryDirectories.push(mediaDirectory)
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx, { mediaDirectory })
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    const baseTarget = { operatorId: '10001', conversationId: 'private:10001:20001' }
    const baseFile = {
      fileName: '测试文件.exe',
      dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
    }
    await expect(control.sendMediaMessage({ ...baseTarget, media: [{ ...baseFile, mimeType: 'application/x-msdownload' }] }))
      .rejects.toThrow('不支持的媒体类型')
    await expect(control.sendMediaMessage({ ...baseTarget, media: [{ ...baseFile, fileName: '测试文件.txt', mimeType: 'text/plain' }] }))
      .rejects.toThrow('媒体大小不能超过')
    // 多媒体中任一文件校验失败时，整条消息拒绝且已落盘的文件被回滚清理。
    await expect(control.sendMediaMessage({
      ...baseTarget,
      media: [
        { fileName: '合法图片.png', mimeType: 'image/png', dataBase64: Buffer.from('valid').toString('base64') },
        { ...baseFile, mimeType: 'application/x-msdownload' },
      ],
    })).rejects.toThrow('不支持的媒体类型')
    expect(control.getSnapshot().messages).toEqual([])
    // 默认用户/机器人/群组头像会预先落盘；失败回滚后只保留这些稳定头像。
    expect(await readdir(mediaDirectory)).toHaveLength(10)
  })

  it('将文件、语音和视频映射为对应的 Koishi 元素与 OneBot 消息段', async () => {
    const app = new App()
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-media-'))
    temporaryDirectories.push(mediaDirectory)
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx, { mediaDirectory })
    })
    runningApps.push(app)

    const received: Array<{ elementType?: string; onebotType?: string }> = []
    app.middleware((session) => {
      const onebot = (session as typeof session & {
        onebot?: { message?: Array<{ type: string }> }
      }).onebot
      received.push({
        elementType: session.elements?.[0]?.type,
        onebotType: onebot?.message?.[0]?.type,
      })
    })
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    for (const media of [
      { fileName: '说明.txt', mimeType: 'text/plain' },
      { fileName: '语音.mp3', mimeType: 'audio/mpeg' },
      { fileName: '视频.mp4', mimeType: 'video/mp4' },
    ]) {
      await control.sendMediaMessage({
        operatorId: '10001',
        conversationId: 'private:10001:20001',
        media: [{ ...media, dataBase64: Buffer.from(media.fileName).toString('base64') }],
      })
    }

    expect(received).toEqual([
      { elementType: 'file', onebotType: 'file' },
      { elementType: 'audio', onebotType: 'record' },
      { elementType: 'video', onebotType: 'video' },
    ])
  })

  it('删除媒体消息所属会话并重新启动内存场景时清理媒体文件', async () => {
    const app = new App()
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-media-'))
    temporaryDirectories.push(mediaDirectory)
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx, { mediaDirectory })
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    await control.sendMediaMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      media: [{ fileName: '待清理图片.png', mimeType: 'image/png', dataBase64: Buffer.from('orphan-image').toString('base64') }],
    })
    expect(await readdir(mediaDirectory)).toHaveLength(12)
    control.deleteUser({ id: '10001' })
    // 删除用户后只回收该用户相关消息媒体，默认实体头像仍被其他参与者/群组引用。
    expect(await readdir(mediaDirectory)).toHaveLength(6)

    await control.sendMediaMessage({
      operatorId: '10002',
      conversationId: 'private:10002:20001',
      media: [{ fileName: '重启前图片.png', mimeType: 'image/png', dataBase64: Buffer.from('restart-image').toString('base64') }],
    })
    expect(await readdir(mediaDirectory)).toHaveLength(8)

    const restartedApp = new App()
    restartedApp.plugin((ctx) => {
      new SandboxControlService(ctx, { mediaDirectory })
    })
    runningApps.push(restartedApp)
    await restartedApp.start()
    // 内存模式重启后会重新生成默认头像，并回收上一个实例残留的消息媒体。
    expect(await readdir(mediaDirectory)).toHaveLength(10)
  })

  it('只返回当前用户可见会话，并按会话有界读取历史', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10001:20001', content: '第一条' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10001:20001', content: '第二条' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10002:20001', content: '其他用户消息' })

    const visible = control.getVisibleSnapshot('10001', 1)
    expect(visible.conversations.every((conversation) => conversation.type === 'direct'
      ? conversation.participantIds.includes('10001')
      : conversation.groupId === '30001')).toBe(true)
    expect(visible.messages.map(({ content }) => content)).toEqual(['第二条'])
    expect(visible.conversations.find(({ id }) => id === 'private:10001:20001')?.messageIds).toEqual([
      visible.messages[0].id,
    ])

    const latest = control.getMessageHistory({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      limit: 1,
    })
    expect(latest.messages.map(({ content }) => content)).toEqual(['第二条'])
    expect(latest.nextBeforeMessageId).toBe(latest.messages[0].id)

    const previous = control.getMessageHistory({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      beforeMessageId: latest.nextBeforeMessageId,
      limit: 1,
    })
    expect(previous.messages.map(({ content }) => content)).toEqual(['第一条'])
    expect(previous.nextBeforeMessageId).toBeUndefined()
    expect(control.getVisibleSnapshot('20001').conversations).toHaveLength(4)
    expect(control.getMessageHistory({
      operatorId: '20001',
      conversationId: 'private:10001:20001',
      limit: 1,
    }).messages.map(({ content }) => content)).toEqual(['第二条'])
    expect(() => control!.getMessageHistory({
      operatorId: '10002',
      conversationId: 'private:10001:20001',
      limit: 20,
    })).toThrow('会话不存在')
  })

  it('按会话正文搜索消息并支持分页与可见性校验', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10001:20001', content: 'Hello Alpha' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10001:20001', content: 'hello Beta' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10001:20001', content: '无关消息' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10001:20001', content: 'HELLO Gamma' })
    // 用户撤回路径直接改 lifecycle，便于断言撤回消息仍可按底层正文命中。
    const recalled = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: 'hello Recalled' })
    await control.recallMessage({ operatorId: '10001', messageId: recalled.messageId })
    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10002:20001', content: 'hello Other' })

    expect(control.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '   ',
    })).toEqual({ hits: [] })

    const datedScene = control.getSnapshot()
    const datedMessages = datedScene.messages.filter(({ conversationId }) => conversationId === 'private:10001:20001')
    datedMessages.forEach((message, index) => {
      message.createdAt = `2026-08-${index < 2 ? '09' : '10'}T0${index}:00:00.000Z`
    })
    control.replaceScene(datedScene)
    const dateOnly = control.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '',
      createdAtStart: '2026-08-10T00:00:00.000Z',
      createdAtEnd: '2026-08-11T00:00:00.000Z',
      limit: 2,
    })
    expect(dateOnly.hits.map(({ summary }) => summary)).toEqual(['hello Recalled', 'HELLO Gamma'])
    expect(dateOnly.nextBeforeMessageId).toBe(dateOnly.hits[1].messageId)
    expect(control.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '无关',
      createdAtStart: '2026-08-10T00:00:00.000Z',
      createdAtEnd: '2026-08-11T00:00:00.000Z',
    }).hits.map(({ summary }) => summary)).toEqual(['无关消息'])
    expect(() => control!.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '',
      createdAtStart: '2026-08-10T00:00:00.000Z',
    })).toThrow('必须同时提供开始和结束时间')
    expect(() => control!.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '',
      createdAtStart: 'invalid',
      createdAtEnd: '2026-08-11T00:00:00.000Z',
    })).toThrow('时间无效')
    expect(() => control!.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '',
      createdAtStart: '2026-08-11T00:00:00.000Z',
      createdAtEnd: '2026-08-10T00:00:00.000Z',
    })).toThrow('结束时间必须晚于开始时间')

    const firstPage = control.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: 'HeLLo',
      limit: 2,
    })
    expect(firstPage.hits.map(({ summary }) => summary)).toEqual(['hello Recalled', 'HELLO Gamma'])
    expect(firstPage.hits[0]).toMatchObject({
      messageId: recalled.messageId,
      authorId: '10001',
    })
    expect(firstPage.nextBeforeMessageId).toBe(firstPage.hits[1].messageId)

    const secondPage = control.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: 'HeLLo',
      beforeMessageId: firstPage.nextBeforeMessageId,
      limit: 2,
    })
    expect(secondPage.hits.map(({ summary }) => summary)).toEqual(['hello Beta', 'Hello Alpha'])
    expect(secondPage.nextBeforeMessageId).toBeUndefined()

    expect(control.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '不存在关键词',
    })).toEqual({ hits: [] })
    expect(() => control!.searchConversationMessages({
      operatorId: '10002',
      conversationId: 'private:10001:20001',
      query: 'hello',
    })).toThrow('会话不存在')
  })

  it('保留回复关系并由目标机器人生成对应 Session 与回复', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)

    const sessions: Array<{
      selfId?: string
      messageId?: string
      quoteId?: string
      rawSelfId?: number
      rawUserId?: number
      rawMessageType?: string
      rawMessage?: Array<{ type: string, data: Record<string, string> }>
    }> = []
    app.middleware((session) => {
      const onebot = (session as typeof session & {
        onebot?: {
          self_id?: number
          user_id?: number
          message_type?: string
          message?: Array<{ type: string, data: Record<string, string> }>
        }
      }).onebot
      sessions.push({
        selfId: session.selfId,
        messageId: session.messageId,
        quoteId: session.quote?.id,
        rawSelfId: onebot?.self_id,
        rawUserId: onebot?.user_id,
        rawMessageType: onebot?.message_type,
        rawMessage: onebot?.message,
      })
      return `回复：${session.content}`
    })
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    control.createBot({ id: '20002', name: 'LLBot 测试机器人', implementation: 'llbot', enabled: true })
    const first = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20002',
      content: '第一条',
    })
    const second = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20002',
      content: '引用回复',
      replyToMessageId: first.messageId,
    })

    expect(sessions).toEqual([
      expect.objectContaining({ selfId: '20002', messageId: first.messageId, rawSelfId: 20002, rawUserId: 10001, rawMessageType: 'private' }),
      expect.objectContaining({
        selfId: '20002',
        messageId: second.messageId,
        quoteId: first.messageId,
        rawSelfId: 20002,
        rawUserId: 10001,
        rawMessageType: 'private',
        rawMessage: [
          { type: 'reply', data: { id: String(getOneBotMessageSequence(first.messageId)) } },
          { type: 'text', data: { text: '引用回复' } },
        ],
      }),
    ])
    expect(control.getSnapshot().messages).toContainEqual(expect.objectContaining({
      id: second.messageId,
      replyToMessageId: first.messageId,
    }))
    expect(control.getSnapshot().messages.find(({ id }) => id === second.messageId)).not.toHaveProperty('botId')
    expect(control.getBotDeliveries().map(({ recipientBotId, messageId }) => ({ recipientBotId, messageId }))).toEqual([
      { recipientBotId: '20002', messageId: first.messageId },
      { recipientBotId: '20002', messageId: second.messageId },
    ])
  })

  it('群聊引用机器人消息时补齐 quote.user，且不自动插入 @', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)

    const sessions: Array<{
      selfId?: string
      userId?: string
      content?: string
      quoteUserId?: string
      quoteUserName?: string
      quoteTimestamp?: number
      atSelf?: boolean
      atIds?: string[]
      rawMessage?: Array<{ type: string, data: Record<string, string> }>
    }> = []
    app.middleware((session) => {
      const onebot = (session as typeof session & {
        onebot?: { message?: Array<{ type: string, data: Record<string, string> }> }
      }).onebot
      sessions.push({
        selfId: session.selfId,
        userId: session.bot.userId,
        content: session.content,
        quoteUserId: session.quote?.user?.id,
        quoteUserName: session.quote?.user?.name,
        quoteTimestamp: session.quote?.timestamp,
        atSelf: session.stripped.atSelf,
        atIds: (session.elements ?? []).filter(({ type }) => type === 'at').map(({ attrs }) => String(attrs.id)),
        rawMessage: onebot?.message,
      })
    })
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    const botMessage = await control.sendMessage({
      operatorId: '20001',
      conversationId: 'group:30001',
      content: '机器人原话',
    })
    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      content: '引用机器人',
      replyToMessageId: botMessage.messageId,
    })

    const storedBotMessage = control.getSnapshot().messages.find(({ id }) => id === botMessage.messageId)
    expect(sessions).toEqual([
      expect.objectContaining({
        selfId: '20001',
        userId: '20001',
        content: '引用机器人',
        quoteUserId: '20001',
        quoteUserName: 'ChatLuna',
        quoteTimestamp: storedBotMessage ? new Date(storedBotMessage.createdAt).getTime() : undefined,
        atSelf: false,
        atIds: [],
        rawMessage: [
          { type: 'reply', data: { id: String(getOneBotMessageSequence(botMessage.messageId)) } },
          { type: 'text', data: { text: '引用机器人' } },
        ],
      }),
    ])
    expect(sessions[0]?.quoteUserId).toBe(sessions[0]?.userId)
    expect(storedBotMessage).toMatchObject({
      authorId: '20001',
      content: '机器人原话',
    })
  })

  it('普通用户发送文本后，被测插件收到正确 Session 并回复到同一会话', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)

    let receivedSession: {
      platform: string | undefined
      selfId: string | undefined
      userId: string | undefined
      channelId: string | undefined
      content: string | undefined
    } | undefined

    app.middleware((session) => {
      receivedSession = {
        platform: session.platform,
        selfId: session.selfId,
        userId: session.userId,
        channelId: session.channelId,
        content: session.content,
      }
      return `收到：${session.content}`
    })

    await app.start()

    if (!control) throw new Error('沙盒控制服务未注册')

    const initial = control.getSnapshot()
    expect(initial.participants.filter(({ kind }) => kind === 'user').map(({ id }) => id)).toEqual(['10001', '10002', '10003'])
    expect(initial.participants.filter(({ kind }) => kind === 'user').map(({ name }) => name)).toEqual(['测试用户1', '测试用户2', '测试用户3'])
    expect(initial.participants).toContainEqual(expect.objectContaining({ kind: 'bot', id: '20001', name: 'ChatLuna' }))
    expect(initial.groups[0]).toMatchObject({
      id: '30001',
      name: '测试群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '10002', role: 'admin' },
        { participantId: '10003', role: 'member' },
        { participantId: '20001', role: 'admin' },
      ],
    })
    expect(initial.conversations).toContainEqual(expect.objectContaining({
      id: 'private:10001:20001',
      type: 'direct',
      messageIds: [],
    }))
    expect(initial.conversations).toContainEqual(expect.objectContaining({
      id: 'group:30001',
      type: 'group',
      groupId: '30001',
      messageIds: [],
    }))

    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '你好',
    })

    expect(receivedSession).toEqual({
      platform: 'onebot',
      selfId: '20001',
      userId: '10001',
      channelId: 'private:10001:20001',
      content: '你好',
    })
    expect(control.getSnapshot().messages).toEqual([
      expect.objectContaining({
        authorId: '10001',
        conversationId: 'private:10001:20001',
        content: '你好',
      }),
      expect.objectContaining({
        authorId: '20001',
        conversationId: 'private:10001:20001',
        content: '收到：你好',
      }),
    ])
  })

  it('群成员可以发布公告并以群聊 Session 向插件发送消息', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)

    let receivedSession: { channelId?: string, guildId?: string, channelType?: number } | undefined
    app.middleware((session) => {
      receivedSession = {
        channelId: session.channelId,
        guildId: session.guildId,
        channelType: session.event.channel?.type,
      }
    })
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    control.setGroupAnnouncement({
      operatorId: '20001',
      groupId: '30001',
      content: '新的群公告',
    })
    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      content: '群聊消息',
    })

    expect(control.getSnapshot().groups[0].announcements[0]).toMatchObject({
      authorId: '20001',
      content: '新的群公告',
    })
    const announcementId = control.getSnapshot().groups[0].announcements[0].id
    control.deleteGroupAnnouncement({
      operatorId: '20001',
      groupId: '30001',
      announcementId,
    })
    expect(control.getSnapshot().groups[0].announcements.some(({ id }) => id === announcementId)).toBe(false)
    expect(receivedSession).toEqual({
      channelId: 'group:30001',
      guildId: '30001',
      channelType: Universal.Channel.Type.TEXT,
    })
    control.createUser({ id: '10004', name: '非成员' })
    await expect(control.sendMessage({
      operatorId: '10004',
      conversationId: 'group:30001',
      content: '非成员消息',
    })).rejects.toThrow('会话不存在')
  })

  it('机器人可以作为发送者写入当前会话且不触发自身中间件', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    let receivedCount = 0
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    app.middleware(() => {
      receivedCount += 1
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    await control.sendMessage({
      operatorId: '20001',
      conversationId: 'private:10001:20001',
      content: '机器人主动消息',
    })

    expect(receivedCount).toBe(0)
    expect(control.getSnapshot().messages).toContainEqual(expect.objectContaining({
      authorId: '20001',
      conversationId: 'private:10001:20001',
      content: '机器人主动消息',
    }))
  })

  it('多选合并转发按时间排序、拒绝事件/撤回，并随场景持久化', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    const older = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '较早消息',
    })
    const newer = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '较晚消息',
    })
    // 传入乱序 messageIds 时，服务端仍按 createdAt + id 稳定排序。
    const result = await control.sendForwardMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageIds: [newer.messageId, older.messageId],
    })
    expect(result.forwardId).toBeTruthy()
    expect(control.getSnapshot().messages.find(({ id }) => id === result.messageId)).toMatchObject({
      authorId: '10001',
      forwardId: result.forwardId,
      content: '测试用户1：较早消息\n测试用户1：较晚消息',
    })
    expect(control.getForwardMessage({
      operatorId: '10001',
      forwardId: result.forwardId,
    }).nodes.map(({ content, sourceMessageId }) => ({ content, sourceMessageId }))).toEqual([
      { content: '较早消息', sourceMessageId: older.messageId },
      { content: '较晚消息', sourceMessageId: newer.messageId },
    ])
    // 全部选自同一个私聊：卡片标题与 QQ 一致写成「A和B的聊天记录」，而不是「群聊的聊天记录」。
    expect(control.getForwardMessage({ operatorId: '10001', forwardId: result.forwardId }).title).toBe('测试用户1和ChatLuna的聊天记录')

    await control.performFriendAction({
      action: 'poke',
      operatorId: '10001',
      targetId: '20001',
      conversationId: 'private:10001:20001',
    })
    const poke = control.getSnapshot().messages.find(({ event }) => event?.type === 'poke')!
    await expect(control.sendForwardMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageIds: [poke.id],
    })).rejects.toThrow('事件消息不能合并转发')

    await control.recallMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: newer.messageId,
    })
    await expect(control.sendForwardMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageIds: [newer.messageId],
    })).rejects.toThrow('已撤回消息不能合并转发')

    await expect(control.sendForwardMessage({
      operatorId: '10001',
      conversationId: 'private:10002:20001',
      messageIds: [older.messageId],
    })).rejects.toThrow('会话不存在')

    const exported = control.getSnapshot()
    expect(exported.forwards).toContainEqual(expect.objectContaining({ id: result.forwardId }))
    control.replaceScene(structuredClone(exported))
    expect(control.getForwardMessage({
      operatorId: '10001',
      messageId: result.messageId,
    }).nodes.map(({ content }) => content)).toEqual(['较早消息', '较晚消息'])

    // 机器人操作者必须走 OneBot action，以便调试记录可见。
    await control.sendForwardMessage({
      operatorId: '20001',
      conversationId: 'private:10001:20001',
      messageIds: [older.messageId],
    })
    expect((await control.getOneBotDebugStore().getRecords({ direction: 'action', action: 'send_forward_msg' })).records[0]).toMatchObject({
      requestedAction: 'send_forward_msg',
      status: 'success',
    })
  })

  it('嵌套合并转发的节点媒体对可达操作者可读，删除会话后级联清理孤儿资源', async () => {
    const app = new App()
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-forward-media-'))
    temporaryDirectories.push(mediaDirectory)
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx, { mediaDirectory })
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    control.createGroup({
      id: '30090',
      name: '外层可见群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '10002', role: 'member' },
        { participantId: '20001', role: 'member' },
      ],
    })
    // 内层资源落在 10002 不可见的私聊；外层卡片挂在双方可见的群聊。
    const hiddenConversationId = 'private:10001:20001'
    const visibleConversationId = 'group:30090'
    const mediaMessage = await control.sendMediaMessage({
      operatorId: '10001',
      conversationId: hiddenConversationId,
      media: [{
        fileName: '嵌套图片.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('nested-forward-image').toString('base64'),
      }],
    })
    const sourceMedia = control.getSnapshot().messages.find(({ id }) => id === mediaMessage.messageId)?.media?.[0]
    expect(sourceMedia?.id).toBeTruthy()
    const mediaId = sourceMedia!.id

    const inner = await control.sendForwardMessage({
      operatorId: '10001',
      conversationId: hiddenConversationId,
      nodes: [{
        type: 'custom',
        userId: '10001',
        nickname: '测试用户1',
        content: '[图片] 嵌套图片.png',
        media: [sourceMedia!],
      }],
    })
    const outer = await control.sendForwardMessage({
      operatorId: '10001',
      conversationId: visibleConversationId,
      nodes: [{
        type: 'custom',
        userId: '10001',
        nickname: '测试用户1',
        content: '[合并转发]',
        forwardId: inner.forwardId,
      }],
    })

    // 10002 看不到内层外层消息，但可通过群聊外层卡片展开嵌套资源。
    expect(() => control!.getForwardMessage({
      operatorId: '10002',
      forwardId: inner.forwardId,
    })).not.toThrow()
    expect(control.getMediaContent({
      operatorId: '10002',
      mediaId,
    })).toMatchObject({
      id: mediaId,
      dataBase64: Buffer.from('nested-forward-image').toString('base64'),
    })

    expect(await readdir(mediaDirectory)).toContain(mediaId)

    // 删除群会话后外层不可达；内层仍被私聊消息引用，资源与媒体应保留。
    control.deleteGroup({ id: '30090' })
    expect(control.getSnapshot().forwards?.some(({ id }) => id === outer.forwardId)).toBe(false)
    expect(control.getSnapshot().forwards?.some(({ id }) => id === inner.forwardId)).toBe(true)
    expect(await readdir(mediaDirectory)).toContain(mediaId)

    // 删除内层所在私聊参与者后，内层 forward 与节点媒体一并回收。
    control.deleteUser({ id: '10001' })
    expect(control.getSnapshot().forwards?.some(({ id }) => id === inner.forwardId || id === outer.forwardId)).toBe(false)
    expect(await readdir(mediaDirectory)).not.toContain(mediaId)
    expect(() => control!.getMediaContent({
      operatorId: '10002',
      mediaId,
    })).toThrow(/媒体不存在或不可见/)
  })
})
