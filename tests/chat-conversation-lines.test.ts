import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SandboxChatConversationLines,
  findChatConversationReset,
  type ChatConversationReset,
} from '../src/chatluna/conversation-lines'
import { SandboxControlService } from '../src/control-service'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

/** 只记下被重置过哪些会话键的假 `chat` 服务；会话键由调用方给定。 */
function createChat(keyOf: (session: unknown) => string | undefined = (session) => (session as { key?: string }).key) {
  const resets: string[] = []
  const chat: ChatConversationReset = {
    conversationKeyOf: keyOf,
    reset: async (conversationKey) => {
      resets.push(conversationKey)
    },
  }
  return { chat, resets }
}

describe('ChatLuna 会话跟随对话线', () => {
  it('第一次派发不重置：那份会话可能正是这条对话线攒下的历史', async () => {
    const { chat, resets } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)

    expect(await lines.followInboundConversation({ botId: '20001', conversationId: 'private:10001:20001', session: { key: 'k' } })).toBe(false)
    expect(resets).toEqual([])
  })

  it('同一条对话线里连续派发不重置，上下文因此不会被自己清掉', async () => {
    const { chat, resets } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)
    const inbound = { botId: '20001', conversationId: 'private:10001:20001', session: { key: 'k' } }

    await lines.followInboundConversation(inbound)
    expect(await lines.followInboundConversation(inbound)).toBe(false)
    expect(await lines.followInboundConversation(inbound)).toBe(false)
    expect(resets).toEqual([])
  })

  it('切到另一条对话线时按会话键重置，切回去时同样重置', async () => {
    const { chat, resets } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)
    const session = { key: 'k' }

    await lines.followInboundConversation({ botId: '20001', conversationId: 'private:10001:20001', session })
    expect(await lines.followInboundConversation({ botId: '20001', conversationId: 'instance-a', session })).toBe(true)
    expect(await lines.followInboundConversation({ botId: '20001', conversationId: 'private:10001:20001', session })).toBe(true)
    expect(resets).toEqual(['k', 'k'])
  })

  it('机器人与会话键各自成一路跟踪，互不触发重置', async () => {
    const { chat, resets } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)

    await lines.followInboundConversation({ botId: '20001', conversationId: 'group:30001', session: { key: 'group' } })
    await lines.followInboundConversation({ botId: '20002', conversationId: 'instance-a', session: { key: 'group' } })
    await lines.followInboundConversation({ botId: '20001', conversationId: 'instance-b', session: { key: 'direct' } })

    expect(resets).toEqual([])
    expect(await lines.followInboundConversation({ botId: '20001', conversationId: 'instance-c', session: { key: 'group' } })).toBe(true)
    expect(resets).toEqual(['group'])
  })

  it('ChatLuna 不在或算不出会话键时静默跳过', async () => {
    let installed: ChatConversationReset | undefined
    const lines = new SandboxChatConversationLines(() => installed)

    expect(await lines.followInboundConversation({ botId: '20001', conversationId: 'a', session: { key: 'k' } })).toBe(false)
    installed = createChat(() => undefined).chat
    expect(await lines.followInboundConversation({ botId: '20001', conversationId: 'b', session: { key: 'k' } })).toBe(false)
  })
})

describe('解析 v2 的 chat 服务', () => {
  it('按 binding 取会话键，按 reset 重置，this 指向服务本身', async () => {
    const resets: string[] = []
    const service = {
      prefix: 'route:',
      binding(this: { prefix: string }, session: { id: string }) {
        return { conversationKey: `${this.prefix}${session.id}` }
      },
      async reset(this: { prefix: string }, key: string) {
        resets.push(`${this.prefix}|${key}`)
      },
    }
    const chat = findChatConversationReset({ get: (name: string) => name === 'chat' ? service : undefined })

    expect(chat?.conversationKeyOf({ id: 'a' })).toBe('route:a')
    await chat?.reset('route:a')
    expect(resets).toEqual(['route:|route:a'])
  })

  it('形状不对时解析不出服务，而不是让派发在调用点上炸掉', () => {
    expect(findChatConversationReset(undefined)).toBeUndefined()
    expect(findChatConversationReset({ get: () => ({ binding() {} }) })).toBeUndefined()
    expect(findChatConversationReset({ get: () => ({ binding() {}, reset: async () => {} }) })?.conversationKeyOf({})).toBeUndefined()
  })
})

describe('入站消息派发时的会话重置', () => {
  /**
   * 假 `chat` 服务按 v2 `routeKeyOf` 的口径算会话键：私聊只看账号，群聊看 channelId。
   * 私聊实例因此与根会话同键，群实例各成一路。
   */
  async function createControl() {
    const resets: string[] = []
    const chat = {
      binding(session: { selfId: string, isDirect: boolean, userId: string, channelId: string }) {
        return { conversationKey: session.isDirect ? `${session.selfId}:user:${session.userId}` : `${session.selfId}:channel:${session.channelId}` }
      },
      async reset(key: string) {
        resets.push(key)
      },
    }
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      ctx.provide('chat')
      Reflect.set(ctx, 'chat', chat)
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')
    return { control, resets }
  }

  it('私聊从根会话切到会话实例时重置 v2 那份会话，同一条线里的追问不再重置', async () => {
    const { control, resets } = await createControl()

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话里的问题' })
    expect(resets).toEqual([])

    const { conversationId } = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里提问' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里追问' })

    expect(resets).toEqual(['20001:user:10001'])
  })

  it('群实例在 v2 里本来就是另一份会话，不触发重置', async () => {
    const { control, resets } = await createControl()

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '群里的问题' })
    const { conversationId } = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'group:30001' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在群实例里提问' })

    expect(resets).toEqual([])
  })
})
