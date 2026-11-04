import { App } from '@koishijs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SandboxChatLunaCharacterContext,
  findChatLunaCharacterChatContext,
  resolveChatLunaCharacterSessionKey,
  type ChatLunaCharacterChatContext,
} from '../src/chatluna/character-context'
import { SandboxControlService } from '../src/control-service'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

/** 只记下被清过哪些会话键的假 chatluna-character 服务。 */
function createChatContext() {
  const cleared: Array<string | undefined> = []
  const chatContext: ChatLunaCharacterChatContext = {
    clear: (sessionKey) => {
      cleared.push(sessionKey)
      return Promise.resolve(true)
    },
  }
  return { chatContext, cleared }
}

describe('chatluna-character 会话键', () => {
  it('私聊按发言者账号、群聊按群号，与被测插件的归档方式一致', () => {
    expect(resolveChatLunaCharacterSessionKey({ type: 'direct' }, '10001')).toBe('private:10001')
    expect(resolveChatLunaCharacterSessionKey({ type: 'group', groupId: '30001' }, '10001')).toBe('group:30001')
  })

  it('同一个根会话与它的实例得到同一个键，这正是需要重置的原因', () => {
    const direct = { type: 'direct' } as const
    expect(resolveChatLunaCharacterSessionKey(direct, '10001'))
      .toBe(resolveChatLunaCharacterSessionKey(direct, '10001'))
  })
})

describe('chatluna-character 对话上下文跟随对话线', () => {
  it('第一次派发不重置，让插件照常按沙盒历史冷回填', async () => {
    const { chatContext, cleared } = createChatContext()
    const tracker = new SandboxChatLunaCharacterContext(() => chatContext)

    expect(await tracker.followInboundConversation({
      botId: '20001',
      sessionKey: 'private:10001',
      conversationId: 'private:10001:20001',
    })).toBe(false)
    expect(cleared).toEqual([])
  })

  it('同一条对话线里连续派发不重置，上下文因此不会被自己清掉', async () => {
    const { chatContext, cleared } = createChatContext()
    const tracker = new SandboxChatLunaCharacterContext(() => chatContext)
    const inbound = { botId: '20001', sessionKey: 'private:10001', conversationId: 'private:10001:20001' }

    await tracker.followInboundConversation(inbound)
    expect(await tracker.followInboundConversation(inbound)).toBe(false)
    expect(await tracker.followInboundConversation(inbound)).toBe(false)
    expect(cleared).toEqual([])
  })

  it('切到另一条对话线时按会话键重置，切回去时同样重置', async () => {
    const { chatContext, cleared } = createChatContext()
    const tracker = new SandboxChatLunaCharacterContext(() => chatContext)

    await tracker.followInboundConversation({ botId: '20001', sessionKey: 'private:10001', conversationId: 'private:10001:20001' })
    expect(await tracker.followInboundConversation({
      botId: '20001',
      sessionKey: 'private:10001',
      conversationId: 'instance-a',
    })).toBe(true)
    expect(await tracker.followInboundConversation({
      botId: '20001',
      sessionKey: 'private:10001',
      conversationId: 'private:10001:20001',
    })).toBe(true)
    expect(cleared).toEqual(['private:10001', 'private:10001'])
  })

  it('机器人与会话键各自成一路跟踪，互不触发重置', async () => {
    const { chatContext, cleared } = createChatContext()
    const tracker = new SandboxChatLunaCharacterContext(() => chatContext)

    await tracker.followInboundConversation({ botId: '20001', sessionKey: 'group:30001', conversationId: 'group:30001' })
    await tracker.followInboundConversation({ botId: '20002', sessionKey: 'group:30001', conversationId: 'instance-a' })
    await tracker.followInboundConversation({ botId: '20001', sessionKey: 'private:10001', conversationId: 'instance-b' })

    expect(cleared).toEqual([])
    expect(await tracker.followInboundConversation({
      botId: '20001',
      sessionKey: 'group:30001',
      conversationId: 'instance-c',
    })).toBe(true)
    expect(cleared).toEqual(['group:30001'])
  })

  it('被测插件不在时静默跳过，但仍然记住这次派发的对话线', async () => {
    let chatContext: ChatLunaCharacterChatContext | undefined
    const tracker = new SandboxChatLunaCharacterContext(() => chatContext)

    await tracker.followInboundConversation({ botId: '20001', sessionKey: 'private:10001', conversationId: 'private:10001:20001' })
    expect(await tracker.followInboundConversation({
      botId: '20001',
      sessionKey: 'private:10001',
      conversationId: 'instance-a',
    })).toBe(false)

    // 插件随后装上：仍在同一条对话线上，因此不重置。
    const installed = createChatContext()
    chatContext = installed.chatContext
    expect(await tracker.followInboundConversation({
      botId: '20001',
      sessionKey: 'private:10001',
      conversationId: 'instance-a',
    })).toBe(false)
    expect(installed.cleared).toEqual([])
  })
})

describe('解析被测 chatluna-character 服务', () => {
  it('先在自己的上下文里取', () => {
    const { chatContext } = createChatContext()
    expect(findChatLunaCharacterChatContext({
      get: (name: string) => name === 'chatluna_character' ? chatContext : undefined,
    })).toBe(chatContext)
  })

  it('自己取不到时用插件注册表里提供方的上下文取一次', () => {
    const { chatContext } = createChatContext()
    expect(findChatLunaCharacterChatContext({
      get: () => undefined,
      registry: {
        values: () => [
          { ctx: { get: () => undefined } },
          { ctx: { get: (name: string) => name === 'chatluna_character' ? chatContext : undefined } },
        ],
      },
    })).toBe(chatContext)
  })

  it('形状不对时解析不出服务，而不是让派发在调用点上炸掉', () => {
    expect(findChatLunaCharacterChatContext(undefined)).toBeUndefined()
    expect(findChatLunaCharacterChatContext({})).toBeUndefined()
    expect(findChatLunaCharacterChatContext({ get: () => ({}) })).toBeUndefined()
    expect(findChatLunaCharacterChatContext({ get: () => undefined, registry: {} })).toBeUndefined()
  })
})

describe('入站消息派发时的对话上下文重置', () => {
  it('从根会话切到会话实例时重置被测插件那份上下文', async () => {
    const { chatContext, cleared } = createChatContext()
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      ctx.provide('chatluna_character')
      Reflect.set(ctx, 'chatluna_character', chatContext)
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话里的问题' })
    expect(cleared).toEqual([])

    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里提问' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里追问' })

    // 只在切换的那一次重置；同一条对话线里的追问不再清。
    expect(cleared).toEqual(['private:10001'])
  })

  it('群实例按群号重置，私聊与群聊各自成一路', async () => {
    const { chatContext, cleared } = createChatContext()
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      ctx.provide('chatluna_character')
      Reflect.set(ctx, 'chatluna_character', chatContext)
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '群里的问题' })
    const { conversationId } = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'group:30001',
    })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在群实例里提问' })

    expect(cleared).toEqual(['group:30001'])
  })
})
