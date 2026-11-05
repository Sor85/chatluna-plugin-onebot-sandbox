import { App } from './helpers/app'
import { Universal, type Session } from '@satorijs/core'
import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, createDefaultScene } from '../src/control-service'
import { listRootConversationInstances, readConversationMessageIds, resolveConversation } from '../src/conversation-resolution'
import type { SandboxSnapshot } from '../src/types'
import { createDirectSession, emitChatLunaEvent } from './helpers/chatluna-state-broadcast'

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createControl(scene?: SandboxSnapshot) {
  const app = new App()
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, scene ? { initialScene: scene } : {})
  })
  runningApps.push(app)
  return { app, control: () => {
    if (!control) throw new Error('沙盒控制服务未注册')
    return control
  } }
}

describe('会话实例端到端', () => {
  it('在实例里发消息时插件收到的是一个独立会话，标准 Koishi 回复回到同一个实例', async () => {
    const { app, control: resolve } = await createControl()
    const observed: Array<{ channelId?: string, channelType?: number, guildId?: string, content?: string }> = []
    app.middleware(async (session, next) => {
      observed.push({
        channelId: session.channelId,
        channelType: session.event.channel?.type,
        guildId: session.guildId,
        content: session.content,
      })
      if (session.content === '在实例里提问') await session.send('实例里的回复')
      return next()
    })
    await app.start()
    const control = resolve()

    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里提问' })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话里提问' })

    // 插件看到的会话标识是实例本身，不是它的根会话。
    expect(observed.map(({ channelId }) => channelId)).toEqual([conversationId, 'private:10001:20001'])
    const scene = control.getSnapshot()
    const reply = scene.messages.find(({ content }) => content === '实例里的回复')
    expect(reply?.conversationId).toBe(conversationId)
    expect(readConversationMessageIds(scene, conversationId)).toEqual([
      expect.any(String),
      reply?.id,
    ])
    // 根会话只有它自己那一条：两条对话线互不污染。
    expect(readConversationMessageIds(scene, 'private:10001:20001')).toHaveLength(1)
  })

  it('ChatLuna 对话状态按实例分叉，状态键与根会话不同', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })

    // 状态的组合键是「机器人参与者 ID + 逻辑会话 ID」，实例因此天然是另一个键，不需要额外规则。
    const instanceSession = control.getRuntimeBot('20001').session({
      type: 'message',
      user: { id: '10001', name: '测试用户1' },
      channel: { id: conversationId, type: Universal.Channel.Type.DIRECT },
    })
    const rootSession = createDirectSession(control, '20001')
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:instance', {}, {}, {}, instanceSession)
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:root', {}, {}, {}, rootSession)

    expect(control.getChatLunaStates().map((state) => ({
      botParticipantId: state.botParticipantId,
      conversationId: state.conversationId,
      thinking: state.thinking,
    }))).toEqual([
      { botParticipantId: '20001', conversationId, thinking: true },
      { botParticipantId: '20001', conversationId: 'private:10001:20001', thinking: true },
    ])
  })

  it('群组的实例在插件那里仍然是群会话，私聊的实例仍是私聊会话', async () => {
    const { app, control: resolve } = await createControl()
    const observed: Array<{ channelId?: string, channelType?: number, guildId?: string, messageType?: unknown }> = []
    app.middleware((session) => {
      observed.push({
        channelId: session.channelId,
        channelType: session.event.channel?.type,
        guildId: session.guildId,
        messageType: (session as { onebot?: { message_type?: unknown } }).onebot?.message_type,
      })
    })
    await app.start()
    const control = resolve()

    const group = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'group:30001',
    })
    const direct = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId: group.conversationId, content: '群实例提问' })
    await control.sendMessage({ operatorId: '10001', conversationId: direct.conversationId, content: '私聊实例提问' })

    // 会话种类来自解析出的会话：实例 ID 没有 group: 前缀，按前缀推断会把群实例判成私聊。
    expect(observed).toEqual([
      {
        channelId: group.conversationId,
        channelType: Universal.Channel.Type.TEXT,
        guildId: '30001',
        messageType: 'group',
      },
      {
        channelId: direct.conversationId,
        channelType: Universal.Channel.Type.DIRECT,
        guildId: undefined,
        messageType: 'private',
      },
    ])
  })

  it('机器人不带 session 直接发消息时，channel 类型仍来自解析出的会话', async () => {
    const { app, control: resolve } = await createControl()
    // 组件转换在渲染 Session 上执行，因此组件看到的 channel 类型就是 sendMessage 推断出的那个。
    app.component('probe-channel', (_attrs, _children, session) => String(session.event.channel?.type))
    await app.start()
    const control = resolve()
    const bot = control.getRuntimeBot('20001')

    const group = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'group:30001' })
    const direct = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })
    await bot.sendMessage(group.conversationId, '<probe-channel/>')
    await bot.sendMessage(direct.conversationId, '<probe-channel/>')

    const scene = control.getSnapshot()
    const contentOf = (conversationId: string) => scene.messages
      .filter((message) => message.conversationId === conversationId)
      .map(({ content }) => content)
    expect(contentOf(group.conversationId)).toEqual([String(Universal.Channel.Type.TEXT)])
    expect(contentOf(direct.conversationId)).toEqual([String(Universal.Channel.Type.DIRECT)])
  })

  it('消息搜索能命中实例里的消息', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    const sent = await control.sendMessage({ operatorId: '10001', conversationId, content: '只存在于实例里的关键词' })

    expect(control.searchConversationMessages({
      operatorId: '10001',
      conversationId,
      query: '只存在于实例里',
    }).hits.map(({ messageId }) => messageId)).toEqual([sent.messageId])
    // 根会话不该命中实例里的消息：会话仍然是搜索的边界。
    expect(control.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '只存在于实例里',
    }).hits).toEqual([])
  })

  it('实例是一等会话：撤回、贴表情、引用与历史分页都可用', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })

    const first = await control.sendMessage({ operatorId: '10001', conversationId, content: '第一条' })
    const second = await control.sendMessage({
      operatorId: '10001',
      conversationId,
      content: '引用第一条',
      replyToMessageId: first.messageId,
    })
    await control.setMessageReaction({ operatorId: '10001', messageId: second.messageId, emojiId: '4', enabled: true })
    await control.recallMessage({ operatorId: '10001', conversationId, messageId: first.messageId })

    const messages = control.getMessageHistory({ operatorId: '10001', conversationId, limit: 10 }).messages
    expect(messages.map(({ content }) => content)).toEqual(['第一条', '引用第一条'])
    expect(messages[0]?.lifecycle).toMatchObject({ status: 'recalled', operatorId: '10001' })
    expect(messages[1]).toMatchObject({
      replyToMessageId: first.messageId,
      reactions: [{ emojiId: '4', participantIds: ['10001'] }],
    })
  })

  it('实例对根会话的全部可见参与者可见，切换当前操作者后仍在', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })

    for (const operatorId of ['10001', '20001']) {
      expect(control.getVisibleSnapshot(operatorId).conversationInstances?.map(({ id }) => id)).toEqual([conversationId])
    }
    // 不在根会话里的参与者看不到它。
    expect(control.getVisibleSnapshot('10002').conversationInstances).toEqual([])
  })

  it('默认场景不生成会话实例', async () => {
    expect(createDefaultScene().conversationInstances).toEqual([])
  })

  it('保留窗口按时间最旧优先淘汰实例与根会话的消息，空实例不被删除', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx, { sceneMessageLimit: 2 })
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    // 先写实例、再写根会话：淘汰必须按时间最旧优先，与会话种类无关。
    await control.sendMessage({ operatorId: '10001', conversationId, content: '实例第一条' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '实例第二条' })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话消息' })

    const scene = control.getSnapshot()
    expect(scene.messages.map(({ content }) => content)).toEqual(['实例第二条', '根会话消息'])
    expect(readConversationMessageIds(scene, conversationId)).toHaveLength(1)

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '再一条根会话消息' })

    const trimmed = control.getSnapshot()
    // 实例最后一条消息被淘汰后实例本身仍然存在：空实例是合法状态。
    expect(listRootConversationInstances(trimmed, 'private:10001:20001').map(({ id }) => id)).toEqual([conversationId])
    expect(readConversationMessageIds(trimmed, conversationId)).toEqual([])
  })
})

describe('原始 OneBot action 的会话观察', () => {
  /** 收到实例内的用户消息后，用原始 OneBot action 回复——真实插件里最常见的那条路径。 */
  function replyWithRawAction(app: App, reply: (session: Session) => Promise<unknown>) {
    app.middleware(async (session, next) => {
      if (session.userId !== '10001') return next()
      await reply(session)
      return next()
    })
  }

  async function findObservedRecord(control: SandboxControlService, action: string) {
    const { records } = await control.getOneBotDebugStore().getRecords({ direction: 'action', action })
    expect(records).toHaveLength(1)
    return records[0]!
  }

  it('原始 send_private_msg 的回复落到根会话，并在调试记录里留下偏离观察', async () => {
    const { app, control: resolve } = await createControl()
    replyWithRawAction(app, (session) => session.bot.internal._request('send_private_msg', {
      user_id: session.userId,
      message: '原始 action 回复',
    }))
    await app.start()
    const control = resolve()

    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    const asked = await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里提问' })

    // 真实 QQ 的 action 表面没有「会话」这一级，沙盒不替插件把回复归位到实例。
    const scene = control.getSnapshot()
    const reply = scene.messages.find(({ content }) => content === '原始 action 回复')
    expect(reply?.conversationId).toBe('private:10001:20001')
    expect(readConversationMessageIds(scene, conversationId)).toEqual([asked.messageId])

    expect((await findObservedRecord(control, 'send_private_msg')).conversationObservation).toEqual({
      kind: 'reply-left-event-conversation',
      eventConversationId: conversationId,
      conversationId: 'private:10001:20001',
    })
  })

  it('原始 send_group_msg 的回复落到群根会话，并在调试记录里留下偏离观察', async () => {
    const { app, control: resolve } = await createControl()
    replyWithRawAction(app, (session) => session.bot.internal._request('send_group_msg', {
      group_id: session.guildId,
      message: '原始群回复',
    }))
    await app.start()
    const control = resolve()

    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'group:30001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在群实例里提问' })

    expect(control.getSnapshot().messages.find(({ content }) => content === '原始群回复')?.conversationId)
      .toBe('group:30001')
    expect((await findObservedRecord(control, 'send_group_msg')).conversationObservation).toEqual({
      kind: 'reply-left-event-conversation',
      eventConversationId: conversationId,
      conversationId: 'group:30001',
    })
  })

  it('事件本来就来自根会话时不产生偏离观察', async () => {
    const { app, control: resolve } = await createControl()
    replyWithRawAction(app, (session) => session.bot.internal._request('send_private_msg', {
      user_id: session.userId,
      message: '原始 action 回复',
    }))
    await app.start()
    const control = resolve()

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '在根会话里提问' })

    expect((await findObservedRecord(control, 'send_private_msg'))).not.toHaveProperty('conversationObservation')
  })

  it('机器人主动发起、不在处理任何入站事件时不产生偏离观察', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })

    await control.getRuntimeBot('20001').internal._request('send_private_msg', {
      user_id: '10001',
      message: '机器人主动私聊',
    })

    expect((await findObservedRecord(control, 'send_private_msg'))).not.toHaveProperty('conversationObservation')
  })

  it('标准 Koishi 回复回到实例本身，因此不算偏离', async () => {
    const { app, control: resolve } = await createControl()
    replyWithRawAction(app, (session) => session.send('标准路径回复'))
    await app.start()
    const control = resolve()

    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里提问' })

    expect(control.getSnapshot().messages.find(({ content }) => content === '标准路径回复')?.conversationId)
      .toBe(conversationId)
    // 标准发送路径（Satori sendMessage）按真实适配器的形态补记一条 send_private_msg，回到实例本身不带偏离观察。
    const { records } = await control.getOneBotDebugStore().getRecords({ direction: 'action' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ requestedAction: 'sendMessage', action: 'send_private_msg', status: 'success' })
    expect(records[0]).not.toHaveProperty('conversationObservation')
  })

  /** 收到消息后按账号或群号查历史——chatluna-character 冷启动回填走的正是这条路径。 */
  function readHistoryWithRawAction(app: App, action: string, params: (session: Session) => Record<string, unknown>) {
    const histories: string[][] = []
    app.middleware(async (session, next) => {
      if (session.userId !== '10001') return next()
      const response = await session.bot.internal._request(action, params(session)) as {
        data: { messages: Array<{ raw_message: string }> }
      }
      histories.push(response.data.messages.map(({ raw_message }) => raw_message))
      return next()
    })
    return histories
  }

  it('实例里的入站事件按账号查私聊历史时读到该实例，并留下跟随观察', async () => {
    const { app, control: resolve } = await createControl()
    const histories = readHistoryWithRawAction(app, 'get_friend_msg_history', (session) => ({
      user_id: session.userId,
      count: 20,
    }))
    await app.start()
    const control = resolve()

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话里的旧问题' })
    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里提问' })

    // 第一次事件来自根会话，读到根会话自己的历史；第二次来自空实例，只读到实例里那一条。
    expect(histories).toEqual([['根会话里的旧问题'], ['在实例里提问']])
    const { records } = await control.getOneBotDebugStore().getRecords({
      direction: 'action',
      action: 'get_friend_msg_history',
      order: 'asc',
    })
    expect(records.map(({ conversationObservation }) => conversationObservation)).toEqual([
      undefined,
      { kind: 'history-followed-event-conversation', eventConversationId: conversationId, conversationId },
    ])
  })

  it('群实例里的入站事件按群号查历史时读到该实例，并留下跟随观察', async () => {
    const { app, control: resolve } = await createControl()
    const histories = readHistoryWithRawAction(app, 'get_group_msg_history', (session) => ({
      group_id: session.guildId,
      count: 20,
    }))
    await app.start()
    const control = resolve()

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '群根会话里的旧问题' })
    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'group:30001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在群实例里提问' })

    expect(histories).toEqual([['群根会话里的旧问题'], ['在群实例里提问']])
    expect((await control.getOneBotDebugStore().getRecords({
      direction: 'action',
      action: 'get_group_msg_history',
      order: 'desc',
    })).records[0]!.conversationObservation).toEqual({
      kind: 'history-followed-event-conversation',
      eventConversationId: conversationId,
      conversationId,
    })
  })

  it('分支实例的历史查询读到继承前缀加自有消息', async () => {
    const { app, control: resolve } = await createControl()
    const histories = readHistoryWithRawAction(app, 'get_friend_msg_history', (session) => ({
      user_id: session.userId,
      count: 20,
    }))
    await app.start()
    const control = resolve()

    const forkPoint = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '分叉点',
    })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '分叉点之后' })
    const { conversationId } = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: forkPoint.messageId,
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '换一种问法' })

    // 分支在插件那里的上下文正是「分叉点及其之前」加自有消息，分叉点之后的原对话不在其中。
    expect(histories.at(-1)).toEqual(['分叉点', '换一种问法'])
  })

  it('插件主动查另一个联系人的历史时不跟随，也不产生观察', async () => {
    const { app, control: resolve } = await createControl()
    const histories = readHistoryWithRawAction(app, 'get_friend_msg_history', () => ({
      user_id: '10002',
      count: 20,
    }))
    await app.start()
    const control = resolve()

    await control.sendMessage({ operatorId: '10002', conversationId: 'private:10002:20001', content: '另一个联系人的历史' })
    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里提问' })

    expect(histories.at(-1)).toEqual(['另一个联系人的历史'])
    expect((await control.getOneBotDebugStore().getRecords({
      direction: 'action',
      action: 'get_friend_msg_history',
      order: 'desc',
    })).records[0]!).not.toHaveProperty('conversationObservation')
  })
})

describe('从消息分叉出会话实例', () => {
  it('分支只记分叉点：不新增消息实体，读出来是继承前缀加自有消息', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    const first = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '第一条' })
    const second = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '第二条引用第一条',
      replyToMessageId: first.messageId,
    })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '分叉点之后' })
    const messageCountBeforeBranch = control.getSnapshot().messages.length

    const { conversationId } = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: second.messageId,
    })

    const scene = control.getSnapshot()
    // 一条消息都没有新增：分支的历史是同一份记录，不是副本。
    expect(scene.messages).toHaveLength(messageCountBeforeBranch)
    const inherited = readConversationMessageIds(scene, conversationId)
      .map((id) => scene.messages.find((message) => message.id === id)!)
    // 分叉点及其之前的那一段，顺序与来源一致，分叉点本身在内、分叉点之后的不在。
    expect(inherited.map(({ content }) => content)).toEqual(['第一条', '第二条引用第一条'])
    // 继承前缀就是来源会话里那两条消息本身，仍然归属来源会话。
    expect(inherited.map(({ id }) => id)).toEqual([first.messageId, second.messageId])
    expect(inherited.every(({ conversationId: owner }) => owner === 'private:10001:20001')).toBe(true)
    // 前缀内的引用指向同一条来源消息，而不是第二份身份。
    expect(inherited[1]?.replyToMessageId).toBe(first.messageId)
    // 来源会话一条不少、一条不改。
    expect(readConversationMessageIds(scene, 'private:10001:20001')).toHaveLength(3)
  })

  it('同一段历史开多个分支后，场景消息实体总数不随分支数增长', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '第一条' })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '第二条' })
    const forkPoint = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '第三条' })
    const messageCount = control.getSnapshot().messages.length

    const branches = [1, 2, 3].map(() => control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: forkPoint.messageId,
    }).conversationId)

    const scene = control.getSnapshot()
    // 单份消息存储：三条分支共享同一段历史，场景消息实体一条都没多。
    expect(scene.messages).toHaveLength(messageCount)
    for (const branch of branches) {
      expect(readConversationMessageIds(scene, branch)).toEqual(readConversationMessageIds(scene, 'private:10001:20001'))
    }
  })

  it('从一个分支里再分叉时，新分支看得到该分支的自有消息与它继承的历史', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    const root = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话消息' })
    const first = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: root.messageId,
    })
    const asked = await control.sendMessage({ operatorId: '10001', conversationId: first.conversationId, content: '第一条分支里的提问' })

    const second = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: first.conversationId,
      messageId: asked.messageId,
    })
    await control.sendMessage({ operatorId: '10001', conversationId: second.conversationId, content: '在实验的基础上继续问' })

    const scene = control.getSnapshot()
    const contentsOf = (conversationId: string) => readConversationMessageIds(scene, conversationId)
      .map((id) => scene.messages.find((message) => message.id === id)!.content)
    // 沿来源链逐段拼接：看到的是上一条分支的那几轮，而不是跳回根会话的历史。
    expect(contentsOf(second.conversationId)).toEqual(['根会话消息', '第一条分支里的提问', '在实验的基础上继续问'])
    expect(contentsOf(first.conversationId)).toEqual(['根会话消息', '第一条分支里的提问'])
    // 存储层级仍严格两层。
    expect(resolveConversation(scene, second.conversationId)?.rootConversationId).toBe('private:10001:20001')
  })

  it('消息历史分页连续跨过继承与自有的边界', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    for (const content of ['根一', '根二', '根三']) {
      await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content })
    }
    const forkPoint = readConversationMessageIds(control.getSnapshot(), 'private:10001:20001').at(-1)!
    const { conversationId } = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: forkPoint,
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '分支一' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '分支二' })

    const readPage = (beforeMessageId?: string) => control.getMessageHistory({
      operatorId: '10001',
      conversationId,
      limit: 2,
      beforeMessageId,
    })
    const pages: string[][] = []
    let cursor: string | undefined
    let page = readPage(cursor)
    while (true) {
      pages.push(page.messages.map(({ content }) => content))
      cursor = page.nextBeforeMessageId
      if (!cursor) break
      page = readPage(cursor)
    }

    // 游标仍是消息 ID，跨越继承与自有的边界对调用方透明：分界处不断页、不漏消息。
    expect(pages).toEqual([['分支一', '分支二'], ['根二', '根三'], ['根一']])
  })

  it('消息搜索命中继承前缀时报那条消息归属的会话', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    const inherited = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '继承前缀里的关键词',
    })
    const { conversationId } = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: inherited.messageId,
    })
    const own = await control.sendMessage({ operatorId: '10001', conversationId, content: '分支自有的关键词' })

    // 在分支里搜到继承前缀时报根会话：一条逻辑消息只有一个会话身份，
    // 按分支重复报告会让结果数随分支数膨胀。
    expect(control.searchConversationMessages({ operatorId: '10001', conversationId, query: '关键词' }).hits
      .map(({ messageId, conversationId: owner }) => ({ messageId, owner })))
      .toEqual([
        { messageId: own.messageId, owner: conversationId },
        { messageId: inherited.messageId, owner: 'private:10001:20001' },
      ])

    // 从分支里再分叉时前缀跨两段，报的仍是每条消息各自的归属会话而不是一律报根会话——
    // 「命中继承前缀时报根会话」在这条链上具体表现为「报那条消息真正所属的那一段」。
    const nested = control.branchConversationInstance({
      operatorId: '10001',
      conversationId,
      messageId: own.messageId,
    })
    expect(control.searchConversationMessages({
      operatorId: '10001',
      conversationId: nested.conversationId,
      query: '关键词',
    }).hits.map(({ conversationId: owner }) => owner)).toEqual([conversationId, 'private:10001:20001'])
  })

  it('清空根会话后分支仍存在，继承部分相应变空', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    const root = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '原始记录' })
    const { conversationId } = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: root.messageId,
    })
    const own = await control.sendMessage({ operatorId: '10001', conversationId, content: '换一种问法' })
    expect(readConversationMessageIds(control.getSnapshot(), conversationId)).toEqual([root.messageId, own.messageId])

    control.clearConversationMessages({ operatorId: '10001', conversationId: 'private:10001:20001' })

    const scene = control.getSnapshot()
    // 与「更早的消息已不在保留窗口内」是同一种体验：整条实验线不会因为整理原始对话而消失。
    expect(resolveConversation(scene, conversationId)).toBeDefined()
    expect(readConversationMessageIds(scene, conversationId)).toEqual([own.messageId])
  })

  it('保留窗口淘汰掉分叉点之前的消息后，继承部分相应缩短', async () => {
    const app = new App()
    let created: SandboxControlService | undefined
    app.plugin((ctx) => {
      created = new SandboxControlService(ctx, { sceneMessageLimit: 3 })
    })
    runningApps.push(app)
    await app.start()
    if (!created) throw new Error('沙盒控制服务未注册')
    const control = created

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '最旧的一条' })
    const forkPoint = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '分叉点' })
    const { conversationId } = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: forkPoint.messageId,
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '分支第一条' })
    // 第四条消息把最旧的那条挤出保留窗口。
    await control.sendMessage({ operatorId: '10001', conversationId, content: '分支第二条' })

    const scene = control.getSnapshot()
    expect(readConversationMessageIds(scene, conversationId)
      .map((id) => scene.messages.find((message) => message.id === id)!.content))
      .toEqual(['分叉点', '分支第一条', '分支第二条'])
  })

  it('没有分叉点的实例只显示自有消息，能正常打开', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话消息' })
    // 空白实例与场景里已有的复制型旧分支形状相同：没有分叉点，只有自有消息。
    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    const own = await control.sendMessage({ operatorId: '10001', conversationId, content: '实例自有消息' })

    expect(readConversationMessageIds(control.getSnapshot(), conversationId)).toEqual([own.messageId])
    expect(control.getMessageHistory({ operatorId: '10001', conversationId }).messages.map(({ content }) => content))
      .toEqual(['实例自有消息'])
  })

  it('默认标题指出来源会话，从实例再分支时指向实例名并归一化到同一根会话', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    const direct = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '私聊消息' })
    const group = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '群消息' })

    const fromDirect = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: direct.messageId,
    })
    const fromGroup = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'group:30001',
      messageId: group.messageId,
    })

    const scene = control.getSnapshot()
    expect(resolveConversation(scene, fromDirect.conversationId)?.title).toBe('分支：ChatLuna')
    expect(resolveConversation(scene, fromGroup.conversationId)?.title).toBe('分支：测试群')

    const nested = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: fromDirect.conversationId,
      messageId: readConversationMessageIds(scene, fromDirect.conversationId)[0]!,
    })
    const nestedConversation = resolveConversation(control.getSnapshot(), nested.conversationId)
    expect(nestedConversation?.title).toBe('分支：分支：ChatLuna')
    // 层级严格两层：从实例分叉仍然挂在同一个根会话下。
    expect(nestedConversation?.rootConversationId).toBe('private:10001:20001')
  })

  it('在分支里发消息时插件看到的上下文包含继承的历史', async () => {
    const { app, control: resolve } = await createControl()
    const observed: Array<{ channelId?: string, history: string[] }> = []
    app.middleware(async (session) => {
      const messages = await session.bot.getMessageList(session.channelId!)
      observed.push({
        channelId: session.channelId,
        history: messages.data.map(({ content }) => content ?? ''),
      })
    })
    await app.start()
    const control = resolve()

    const first = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '分叉点之前' })
    const { conversationId } = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: first.messageId,
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '换一种问法' })

    expect(observed.at(-1)).toEqual({
      channelId: conversationId,
      history: ['分叉点之前', '换一种问法'],
    })
  })

  it('分叉点消息不在该会话里时按消息不存在拒绝', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const sent = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '群消息' })

    expect(() => control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: sent.messageId,
    })).toThrow(`消息不存在：${sent.messageId}`)
  })
})

describe('分支里的继承前缀只读', () => {
  /** 一条根会话消息，加上从它分叉出来的分支，以及分支自己的一条消息。 */
  async function createBranch(control: SandboxControlService) {
    const inherited = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '分叉点那句话',
    })
    const { conversationId } = control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: inherited.messageId,
    })
    const own = await control.sendMessage({ operatorId: '10001', conversationId, content: '换一种问法' })
    return { inherited, own, conversationId }
  }

  it('在分支里撤回继承前缀被拒绝，在根会话里撤回同一条消息仍然正常', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { inherited, own, conversationId } = await createBranch(control)

    await expect(control.recallMessage({ operatorId: '10001', conversationId, messageId: inherited.messageId }))
      .rejects.toThrow(`消息不存在：${inherited.messageId}`)
    // 分支自有的消息不受影响：只读约束的是继承来的那一段。
    await control.recallMessage({ operatorId: '10001', conversationId, messageId: own.messageId })

    // 原始记录仍然可以在它自己的会话里撤回，撤回后分支里如实反映。
    await control.recallMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: inherited.messageId,
    })
    expect(control.getMessageHistory({ operatorId: '10001', conversationId }).messages
      .map(({ content, lifecycle }) => ({ content, status: lifecycle?.status })))
      .toEqual([
        { content: '分叉点那句话', status: 'recalled' },
        { content: '换一种问法', status: 'recalled' },
      ])
  })

  it('在分支里给继承前缀贴表情被拒绝，在根会话里给同一条消息贴表情仍然正常', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { inherited, own, conversationId } = await createBranch(control)

    await expect(control.setMessageReaction({
      operatorId: '10001',
      conversationId,
      messageId: inherited.messageId,
      emojiId: '76',
      enabled: true,
    })).rejects.toThrow(`消息不存在：${inherited.messageId}`)
    expect(control.getSnapshot().messages.find(({ id }) => id === inherited.messageId)?.reactions).toBeUndefined()

    // 分支自有的消息照常可贴。
    await control.setMessageReaction({
      operatorId: '10001',
      conversationId,
      messageId: own.messageId,
      emojiId: '76',
      enabled: true,
    })
    // 原会话里同一条消息照常可贴，贴上的回应在分支里如实呈现——同一条消息只有一套附属事实。
    await control.setMessageReaction({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageId: inherited.messageId,
      emojiId: '4',
      enabled: true,
    })
    expect(control.getMessageHistory({ operatorId: '10001', conversationId }).messages
      .map(({ content, reactions }) => ({ content, reactions })))
      .toEqual([
        { content: '分叉点那句话', reactions: [{ emojiId: '4', participantIds: ['10001'] }] },
        { content: '换一种问法', reactions: [{ emojiId: '76', participantIds: ['10001'] }] },
      ])
  })

  it('机器人操作者在分支里给继承前缀贴表情同样被拒，贴到分支自有消息上照常生效', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { inherited, own, conversationId } = await createBranch(control)

    // 机器人操作者要绕一圈自身 OneBot action，而 action 表面没有「会话」这一级：
    // 判定必须发生在分流之前，否则只读约束会因操作者种类而失效。
    await expect(control.setMessageReaction({
      operatorId: '20001',
      conversationId,
      messageId: inherited.messageId,
      emojiId: '76',
      enabled: true,
    })).rejects.toThrow(`消息不存在：${inherited.messageId}`)
    expect(control.getSnapshot().messages.find(({ id }) => id === inherited.messageId)?.reactions).toBeUndefined()

    await control.setMessageReaction({
      operatorId: '20001',
      conversationId,
      messageId: own.messageId,
      emojiId: '76',
      enabled: true,
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === own.messageId)?.reactions)
      .toEqual([{ emojiId: '76', participantIds: ['20001'] }])
  })

  it('不指定会话的表情回应按消息自身归属执行，插件通道因此不受分支视图的只读约束', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { inherited } = await createBranch(control)

    // 只读约束的是用户在分支视图里的入口；插件寻址的是根会话的一条普通消息。
    await control.setMessageReaction({
      operatorId: '10001',
      messageId: inherited.messageId,
      emojiId: '76',
      enabled: true,
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === inherited.messageId)?.reactions)
      .toEqual([{ emojiId: '76', participantIds: ['10001'] }])
  })

  it('清空分支只清掉它自有的消息，继承前缀不受影响', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { inherited, own, conversationId } = await createBranch(control)

    control.clearConversationMessages({ operatorId: '10001', conversationId })

    const scene = control.getSnapshot()
    expect(scene.messages.map(({ id }) => id)).toEqual([inherited.messageId])
    // 清空之后分支里仍然读得到继承前缀：它是原会话的记录，不属于这条分支。
    expect(readConversationMessageIds(scene, conversationId)).toEqual([inherited.messageId])
    expect(readConversationMessageIds(scene, 'private:10001:20001')).toEqual([inherited.messageId])
    expect(scene.messages.some(({ id }) => id === own.messageId)).toBe(false)
  })

  it('在分支里引用继承前缀回复成功，回复归属该分支', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { inherited, conversationId } = await createBranch(control)

    const reply = await control.sendMessage({
      operatorId: '10001',
      conversationId,
      content: '在分叉点那句话上换一种问法',
      replyToMessageId: inherited.messageId,
    })

    const scene = control.getSnapshot()
    const message = scene.messages.find(({ id }) => id === reply.messageId)
    expect(message).toMatchObject({ conversationId, replyToMessageId: inherited.messageId })
    // 回复落在分支里，原会话一条都没多。
    expect(readConversationMessageIds(scene, 'private:10001:20001')).toEqual([inherited.messageId])

    // 从分支里再分叉时，继承前缀跨两段，被引用的消息在链上任一段里都算可读。
    const nested = control.branchConversationInstance({
      operatorId: '10001',
      conversationId,
      messageId: reply.messageId,
    })
    const nestedReply = await control.sendMessage({
      operatorId: '10001',
      conversationId: nested.conversationId,
      content: '再引用一次根会话那句话',
      replyToMessageId: inherited.messageId,
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === nestedReply.messageId))
      .toMatchObject({ conversationId: nested.conversationId, replyToMessageId: inherited.messageId })
  })

  it('引用不在当前会话里可读的消息仍然被拒绝', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const { own, conversationId } = await createBranch(control)
    const afterFork = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '分叉点之后的消息',
    })

    // 分叉点之后的原会话消息不属于这条分支的继承前缀。
    await expect(control.sendMessage({
      operatorId: '10001',
      conversationId,
      content: '引用分叉点之后的消息',
      replyToMessageId: afterFork.messageId,
    })).rejects.toThrow(`回复消息不存在：${afterFork.messageId}`)
    // 反向同理：分支自有的消息在根会话里不可读。
    await expect(control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '引用分支里的消息',
      replyToMessageId: own.messageId,
    })).rejects.toThrow(`回复消息不存在：${own.messageId}`)
  })
})

describe('实例重命名与删除', () => {
  it('改名后场景与可见投影里的标题同步，根会话不能改名', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const first = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })
    const second = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })

    // 两个实例都用默认名，改名是把它们区分开的唯一手段。
    expect(listRootConversationInstances(control.getSnapshot(), 'private:10001:20001').map(({ title }) => title))
      .toEqual(['新会话', '新会话'])

    control.renameConversationInstance({
      operatorId: '10001',
      conversationId: second.conversationId,
      title: '  换一种问法  ',
    })

    expect(listRootConversationInstances(control.getSnapshot(), 'private:10001:20001').map(({ id, title }) => ({ id, title })))
      .toEqual([
        { id: first.conversationId, title: '新会话' },
        { id: second.conversationId, title: '换一种问法' },
      ])
    expect(control.getVisibleSnapshot('20001').conversationInstances?.map(({ title }) => title))
      .toEqual(['新会话', '换一种问法'])

    expect(() => control.renameConversationInstance({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      title: '给根会话改名',
    })).toThrow('会话实例不存在：private:10001:20001')
    expect(() => control.renameConversationInstance({
      operatorId: '10001',
      conversationId: second.conversationId,
      title: '   ',
    })).toThrow('会话名称不能为空')
  })

  it('删除实例后它的消息不再存在于场景中，根会话与其他实例不受影响', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const root = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话消息' })
    const removed = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })
    const kept = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })
    const dropped = await control.sendMessage({ operatorId: '10001', conversationId: removed.conversationId, content: '要删掉的提问' })
    const keptMessage = await control.sendMessage({ operatorId: '10001', conversationId: kept.conversationId, content: '留下的提问' })

    control.deleteConversationInstance({ operatorId: '10001', conversationId: removed.conversationId })

    const scene = control.getSnapshot()
    expect(resolveConversation(scene, removed.conversationId)).toBeUndefined()
    expect(scene.messages.map(({ id }) => id)).toEqual([root.messageId, keptMessage.messageId])
    expect(scene.messages.some(({ id }) => id === dropped.messageId)).toBe(false)
    expect(readConversationMessageIds(scene, 'private:10001:20001')).toEqual([root.messageId])
    expect(listRootConversationInstances(scene, 'private:10001:20001').map(({ id }) => id)).toEqual([kept.conversationId])
    // 消息搜索不再命中被删实例里的内容。
    expect(control.searchConversationMessages({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      query: '要删掉的提问',
    }).hits).toEqual([])
  })

  it('根会话不可删除', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()

    expect(() => control.deleteConversationInstance({ operatorId: '10001', conversationId: 'private:10001:20001' }))
      .toThrow('会话实例不存在：private:10001:20001')
    expect(() => control.deleteConversationInstance({ operatorId: '10001', conversationId: 'group:30001' }))
      .toThrow('会话实例不存在：group:30001')
    expect(resolveConversation(control.getSnapshot(), 'private:10001:20001')).toBeDefined()
  })

  it('删除实例会清理失去引用的合并转发资源与媒体', async () => {
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'sandbox-instance-delete-'))
    temporaryDirectories.push(mediaDirectory)
    const app = new App()
    let created: SandboxControlService | undefined
    app.plugin((ctx) => {
      created = new SandboxControlService(ctx, { mediaDirectory })
    })
    runningApps.push(app)
    await app.start()
    if (!created) throw new Error('沙盒控制服务未注册')
    const control = created

    const { conversationId } = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })
    const media = control.storeMedia({
      fileName: 'branch.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('branch-only-payload').toString('base64'),
    })
    await control.sendStoredMediaMessage({ operatorId: '10001', conversationId, content: '', media: [media] })
    const quoted = await control.sendMessage({ operatorId: '10001', conversationId, content: '被转发的消息' })
    const forwarded = await control.sendForwardMessage({
      operatorId: '10001',
      conversationId,
      messageIds: [quoted.messageId],
    })
    expect(control.getSnapshot().forwards?.map(({ id }) => id)).toEqual([forwarded.forwardId])
    expect(readdirSync(mediaDirectory)).toContain(media.id)

    control.deleteConversationInstance({ operatorId: '10001', conversationId })

    // 合并转发资源失去外层消息引用后一并回收，媒体随之不再被任何引用持有。
    expect(control.getSnapshot().forwards).toEqual([])
    expect(readdirSync(mediaDirectory)).not.toContain(media.id)
  })

  it('删除好友、被移出群与群组解散后对应根会话下的实例连带消失', async () => {
    const { app, control: resolve } = await createControl()
    await app.start()
    const control = resolve()
    const direct = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })
    const group = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'group:30001' })

    await control.performFriendAction({ operatorId: '10001', action: 'delete', targetId: '20001' })
    // 解除好友只撤销可见性，实例随根会话一起从操作者视角消失。
    expect(control.getVisibleSnapshot('10001').conversationInstances?.map(({ id }) => id)).toEqual([group.conversationId])

    // 10003 是群成员，因此本来看得到群实例；被群主移出群后它随根会话一起消失。
    expect(control.getVisibleSnapshot('10003').conversationInstances?.map(({ id }) => id)).toEqual([group.conversationId])
    await control.performGroupAction({ operatorId: '10001', action: 'kick', groupId: '30001', targetId: '10003' })
    expect(control.getVisibleSnapshot('10003').conversationInstances).toEqual([])
    // 仍在群里的参与者继续看到群实例。
    expect(control.getVisibleSnapshot('10002').conversationInstances?.map(({ id }) => id)).toEqual([group.conversationId])

    control.deleteGroup({ id: '30001' })
    // 群组解散时根会话真的消失，实例连带清理，不留下无主的对话线。
    expect(control.getSnapshot().conversationInstances?.map(({ id }) => id)).toEqual([direct.conversationId])
    expect(resolveConversation(control.getSnapshot(), group.conversationId)).toBeUndefined()

    control.deleteBot({ id: '20001' })
    expect(control.getSnapshot().conversationInstances).toEqual([])
  })
})
