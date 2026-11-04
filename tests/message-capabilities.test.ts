import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import { getOneBotMessageSequence } from '../src/onebot-profiles'
import type { ResolvedConversation } from '../src/conversation-resolution'
import { denyMessageCapability, readMessageCapabilities } from '../src/message-capabilities'
import type { SandboxAppearance, SandboxGroup, SandboxMessage } from '../src/types'

const DIRECT: ResolvedConversation = {
  id: 'private:10001:20001',
  kind: 'root',
  rootConversationId: 'private:10001:20001',
  type: 'direct',
  participantIds: ['10001', '20001'],
}

const GROUP_CONVERSATION: ResolvedConversation = {
  id: 'group:30001',
  kind: 'root',
  rootConversationId: 'group:30001',
  type: 'group',
  groupId: '30001',
}

const BRANCH: ResolvedConversation = {
  id: 'branch-1',
  kind: 'instance',
  rootConversationId: 'private:10001:20001',
  type: 'direct',
  participantIds: ['10001', '20001'],
  title: '换一种问法',
}

const GROUP: SandboxGroup = {
  id: '30001',
  name: '测试群',
  announcements: [],
  members: [
    { participantId: '10001', role: 'owner' },
    { participantId: '10002', role: 'admin' },
    { participantId: '10003', role: 'admin' },
    { participantId: '10004', role: 'member' },
  ],
}

function message(authorId: string, conversationId: string, extra: Partial<SandboxMessage> = {}): SandboxMessage {
  return {
    id: `message:${authorId}`,
    authorId,
    conversationId,
    content: '一句话',
    createdAt: '2026-08-30T00:00:00.000Z',
    ...extra,
  } as SandboxMessage
}

const recalled = (authorId: string, conversationId: string) => message(authorId, conversationId, {
  lifecycle: { status: 'recalled', operatorId: authorId, recalledAt: '2026-08-30T00:01:00.000Z' },
})

const pokeEvent = (authorId: string, conversationId: string) => message(authorId, conversationId, {
  event: { type: 'poke', targetId: '20001' },
})

describe('消息能力判据', () => {
  it('自己的消息随时可撤回，私聊里撤别人的做不到', () => {
    expect(readMessageCapabilities({
      message: message('10001', DIRECT.id),
      conversation: DIRECT,
      operatorId: '10001',
    })).toEqual({ recall: true, react: true, reply: true, branch: true, forward: true })

    expect(denyMessageCapability('recall', {
      message: message('20001', DIRECT.id),
      conversation: DIRECT,
      operatorId: '10001',
    })).toBe('not-own-message')
  })

  it('群主可撤成员与管理员的消息，管理员撤不了群主或同级管理员', () => {
    const askRecall = (operatorId: string, authorId: string) => denyMessageCapability('recall', {
      message: message(authorId, GROUP_CONVERSATION.id),
      conversation: GROUP_CONVERSATION,
      operatorId,
      group: GROUP,
    })

    expect(askRecall('10001', '10004')).toBeUndefined()
    expect(askRecall('10001', '10002')).toBeUndefined()
    expect(askRecall('10002', '10004')).toBeUndefined()
    // 阶梯的两条上限：群主不可撤，同级管理员不可撤。
    expect(askRecall('10002', '10001')).toBe('target-outranks-actor')
    expect(askRecall('10002', '10003')).toBe('target-outranks-actor')
    // 普通成员撤不了别人的任何一条。
    expect(askRecall('10004', '10001')).toBe('requires-group-authority')
    expect(askRecall('10004', '10002')).toBe('requires-group-authority')
    expect(askRecall('10004', '10003')).toBe('requires-group-authority')
    // 自己的消息不过阶梯，普通成员照样可撤。
    expect(askRecall('10004', '10004')).toBeUndefined()
  })

  it('操作者或消息作者不在群组里时按不在群组拒绝，而不是放行', () => {
    expect(denyMessageCapability('recall', {
      message: message('10004', GROUP_CONVERSATION.id),
      conversation: GROUP_CONVERSATION,
      operatorId: '19999',
      group: GROUP,
    })).toBe('actor-not-in-group')

    expect(denyMessageCapability('recall', {
      message: message('19999', GROUP_CONVERSATION.id),
      conversation: GROUP_CONVERSATION,
      operatorId: '10001',
      group: GROUP,
    })).toBe('author-not-in-group')
  })

  it('没有当前操作者时撤回与贴表情都做不到', () => {
    const capabilities = readMessageCapabilities({
      message: message('10001', DIRECT.id),
      conversation: DIRECT,
    })

    expect(capabilities).toMatchObject({ recall: false, react: false })
    expect(denyMessageCapability('recall', { message: message('10001', DIRECT.id), conversation: DIRECT }))
      .toBe('no-operator')
    expect(denyMessageCapability('react', { message: message('10001', DIRECT.id), conversation: DIRECT }))
      .toBe('no-operator')
  })

  it('事件消息不可贴表情、不可分叉、不可合并转发、不可引用，也不可撤回', () => {
    const input = { message: pokeEvent('10001', DIRECT.id), conversation: DIRECT, operatorId: '10001' }

    expect(readMessageCapabilities(input)).toEqual({
      recall: false,
      react: false,
      reply: false,
      branch: false,
      forward: false,
    })
    expect(denyMessageCapability('react', input)).toBe('event-message')
    expect(denyMessageCapability('branch', input)).toBe('event-message')
    expect(denyMessageCapability('forward', input)).toBe('event-message')
    expect(denyMessageCapability('reply', input)).toBe('event-message')
  })

  it('已撤回消息不可回复、不可再贴表情、不可合并转发，但仍可作为分叉点', () => {
    const input = { message: recalled('10001', DIRECT.id), conversation: DIRECT, operatorId: '10001' }

    expect(readMessageCapabilities(input)).toEqual({
      recall: false,
      react: false,
      reply: false,
      branch: true,
      forward: false,
    })
    expect(denyMessageCapability('reply', input)).toBe('recalled-message')
    expect(denyMessageCapability('react', input)).toBe('recalled-message')
    expect(denyMessageCapability('forward', input)).toBe('recalled-message')
    expect(denyMessageCapability('recall', input)).toBe('recalled-message')
  })

  it('继承前缀在实例视图里不可撤回也不可贴表情，但可以引用它继续追问', () => {
    const inherited = { message: message('10001', DIRECT.id), conversation: BRANCH, operatorId: '10001' }

    expect(readMessageCapabilities(inherited)).toEqual({
      recall: false,
      react: false,
      reply: true,
      branch: true,
      forward: true,
    })
    expect(denyMessageCapability('recall', inherited)).toBe('inherited-prefix')
    expect(denyMessageCapability('react', inherited)).toBe('inherited-prefix')

    // 同一条消息在它自己的会话里照旧可撤可贴：只读约束的是实例视图里的入口。
    expect(readMessageCapabilities({ ...inherited, conversation: DIRECT }))
      .toMatchObject({ recall: true, react: true })
    // 分支自有的消息不受约束。
    expect(readMessageCapabilities({ message: message('10001', BRANCH.id), conversation: BRANCH, operatorId: '10001' }))
      .toMatchObject({ recall: true, react: true })
  })
})

const appearance: SandboxAppearance = {
  enableSandboxFrostedGlass: true,
  sandboxTimBubbleTail: true,
  sandboxColorMode: 'auto',
  sandboxAccentColor: '#2563eb',
  sandboxMarkRecalledMessages: true,
}

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

/** 群里的一条戳一戳事件消息。 */
async function createPokeEvent(control: SandboxControlService) {
  await control.performGroupAction({
    action: 'poke',
    operatorId: '10001',
    groupId: '30001',
    targetId: '10003',
  })
  const event = control.getSnapshot().messages.at(-1)
  if (!event?.event) throw new Error('戳一戳事件消息未创建')
  return event
}

describe('服务端按消息能力拒绝', () => {
  it('给一条戳一戳事件贴表情被拒绝，事件消息上没有留下回应事实', async () => {
    const { control } = await createControl()
    const event = await createPokeEvent(control)

    await expect(control.setMessageReaction({
      operatorId: '10001',
      conversationId: 'group:30001',
      messageId: event.id,
      emojiId: '76',
      enabled: true,
    })).rejects.toThrow('事件消息不支持表情回应')
    expect(control.getSnapshot().messages.find(({ id }) => id === event.id)?.reactions).toBeUndefined()
  })

  it('经 Console 端点给事件消息贴表情同样被拒绝：挡住它的不再只是菜单', async () => {
    const { control } = await createControl()
    const event = await createPokeEvent(control)
    const listeners = new Map<string, (input: unknown) => unknown>()
    const registrar: SandboxConsoleRegistrar = {
      addEntry() {},
      addListener(name, callback) {
        listeners.set(name, callback as (input: unknown) => unknown)
      },
      broadcast() {},
    }
    registerConsole(registrar, control, appearance)
    const setMessageReaction = listeners.get('onebot-sandbox.set-message-reaction')
    if (!setMessageReaction) throw new Error('表情回应端点未注册')

    await expect(setMessageReaction({
      operatorId: '10001',
      conversationId: 'group:30001',
      messageId: event.id,
      emojiId: '76',
      enabled: true,
    })).rejects.toThrow('事件消息不支持表情回应')
  })

  it('从一条事件消息分叉被拒绝，场景里不留下这条分支', async () => {
    const { control } = await createControl()
    const event = await createPokeEvent(control)

    expect(() => control.branchConversationInstance({
      operatorId: '10001',
      conversationId: 'group:30001',
      messageId: event.id,
    })).toThrow(`事件消息不能作为分叉点：${event.id}`)
    expect(control.getSnapshot().conversationInstances).toEqual([])
  })

  it('引用一条已撤回的消息被拒绝，撤回因此没有引用这条旁路', async () => {
    const { control } = await createControl()
    const target = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '待撤回的原文',
    })
    await control.recallMessage({ operatorId: '10001', messageId: target.messageId })

    await expect(control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '引用它',
      replyToMessageId: target.messageId,
    })).rejects.toThrow(`已撤回消息不能引用回复：${target.messageId}`)
    expect(control.getSnapshot().messages.some(({ content }) => content === '引用它')).toBe(false)
  })

  it('引用一条戳一戳事件被拒绝：系统提示不是可引用的消息', async () => {
    const { control } = await createControl()
    const event = await createPokeEvent(control)

    await expect(control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      content: '引用这条系统提示',
      replyToMessageId: event.id,
    })).rejects.toThrow(`事件消息不能引用回复：${event.id}`)
    expect(control.getSnapshot().messages.some(({ content }) => content === '引用这条系统提示')).toBe(false)
  })

  it('机器人经 OneBot send_msg 引用一条戳一戳事件同样被拒绝', async () => {
    const { control } = await createControl()
    const event = await createPokeEvent(control)

    await expect(control.getRuntimeBot('20001').internal._request('send_msg', {
      group_id: 30001,
      message: [
        { type: 'reply', data: { id: String(getOneBotMessageSequence(event.id)) } },
        { type: 'text', data: { text: '引用这条系统提示' } },
      ],
    })).rejects.toThrow(/事件消息不能引用回复/)
  })

  it('撤回的群角色阶梯收成一处后行为与文案不变', async () => {
    const { control } = await createControl()
    const memberMessage = await control.sendMessage({
      operatorId: '10003',
      conversationId: 'group:30001',
      content: '普通成员的消息',
    })
    const ownerMessage = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      content: '群主的消息',
    })
    const adminMessage = await control.sendMessage({
      operatorId: '10002',
      conversationId: 'group:30001',
      content: '管理员的消息',
    })

    // 普通成员撤不了别人的消息。
    await expect(control.recallMessage({ operatorId: '10003', messageId: ownerMessage.messageId }))
      .rejects.toThrow('只有群主或管理员可以撤回成员消息')
    // 管理员撤不了群主与同级管理员的消息；机器人 20001 在默认场景里也是管理员。
    await expect(control.recallMessage({ operatorId: '10002', messageId: ownerMessage.messageId }))
      .rejects.toThrow('管理员不能管理群主或其他管理员')
    // 私聊里没有角色阶梯可依。
    const directMessage = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '私聊里的消息',
    })
    await expect(control.recallMessage({ operatorId: '20001', messageId: directMessage.messageId }))
      .rejects.toThrow('只能撤回自己发送的消息')

    // 允许的那几条照旧：管理员撤成员、群主撤管理员、作者撤自己。
    await control.recallMessage({ operatorId: '10002', messageId: memberMessage.messageId })
    await control.recallMessage({ operatorId: '10001', messageId: adminMessage.messageId })
    await control.recallMessage({ operatorId: '10001', messageId: ownerMessage.messageId })
    expect(control.getSnapshot().messages
      .filter(({ conversationId }) => conversationId === 'group:30001')
      .map(({ content, lifecycle }) => ({ content, status: lifecycle?.status })))
      .toEqual([
        { content: '普通成员的消息', status: 'recalled' },
        { content: '群主的消息', status: 'recalled' },
        { content: '管理员的消息', status: 'recalled' },
      ])
  })

  it('事件消息与已撤回消息的合并转发拒绝行为不变', async () => {
    const { control } = await createControl()
    const event = await createPokeEvent(control)
    const target = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      content: '待撤回的原文',
    })
    await control.recallMessage({ operatorId: '10001', messageId: target.messageId })

    await expect(control.sendForwardMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      messageIds: [event.id],
    })).rejects.toThrow(`事件消息不能合并转发：${event.id}`)
    await expect(control.sendForwardMessage({
      operatorId: '10001',
      conversationId: 'group:30001',
      messageIds: [target.messageId],
    })).rejects.toThrow(`已撤回消息不能合并转发：${target.messageId}`)
  })
})
