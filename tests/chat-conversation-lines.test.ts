import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SandboxChatConversationLines,
  findChatConversationHeads,
  type ChatConversationHeads,
} from '../src/chatluna/conversation-lines'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

/** 记下每个会话键头会话的假运行时；会话键由调用方给定，直接改 heads 模拟 v2 自己重置（用户清空会话）。 */
function createChat(keyOf: (session: unknown) => string | undefined = (session) => (session as { key?: string }).key) {
  const heads = new Map<string, string>()
  const switches: string[] = []
  const chat: ChatConversationHeads = {
    conversationKeyOf: keyOf,
    head: async (key) => heads.get(key),
    switch: async (key, sessionId) => {
      heads.set(key, sessionId)
      switches.push(sessionId)
    },
  }
  return { chat, heads, switches }
}

const session = { key: 'k' }
const main = { session }
const space = (scopeId: string) => ({ scopeId, session })
const instance = (instanceId: string, scopeId?: string) => ({ scopeId, instanceId, session })

describe('ChatLuna 会话跟随对话线', () => {
  it('主场景根会话沿用 v2 默认会话：新键不切换，已有的头会话原样接手', async () => {
    const { chat, heads, switches } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)

    expect(await lines.followInboundConversation(main)).toBe(false)
    heads.set('k', 'route:k:r1234')
    expect(await lines.followInboundConversation(main)).toBe(false)
    expect(switches).toEqual([])
  })

  it('测试空间各用一份会话，切回主场景回到主场景自己的历史', async () => {
    const { chat, heads, switches } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)
    heads.set('k', 'route:k')

    expect(await lines.followInboundConversation(space('a'))).toBe(true)
    expect(await lines.followInboundConversation(space('a'))).toBe(false)
    expect(await lines.followInboundConversation(space('b'))).toBe(true)
    expect(await lines.followInboundConversation(main)).toBe(true)
    expect(await lines.followInboundConversation(space('a'))).toBe(true)
    expect(switches).toEqual(['route:k:sandbox-space-a', 'route:k:sandbox-space-b', 'route:k', 'route:k:sandbox-space-a'])
  })

  it('私聊实例另成一份会话，切回根会话时根会话的上下文还在', async () => {
    const { chat, switches } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)

    await lines.followInboundConversation(main)
    expect(await lines.followInboundConversation(instance('i1'))).toBe(true)
    expect(await lines.followInboundConversation(main)).toBe(true)
    await lines.followInboundConversation(instance('i1', 'a'))
    expect(switches).toEqual(['route:k:sandbox-line-i1', 'route:k', 'route:k:sandbox-space-a:sandbox-line-i1'])
  })

  it('v2 自己重置出的新会话归当时占着键的对话线，切走再切回仍是它', async () => {
    const { chat, heads, switches } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)

    await lines.followInboundConversation(space('a'))
    heads.set('k', 'route:k:rCleared')
    await lines.followInboundConversation(main)
    await lines.followInboundConversation(space('a'))
    expect(switches).toEqual(['route:k:sandbox-space-a', 'route:k', 'route:k:rCleared'])
  })

  it('重启后：新空间不接手任何旧会话，不带后缀的头会话归主场景根会话', async () => {
    const { chat, heads, switches } = createChat()
    heads.set('k', 'route:k:sandbox-space-old')
    const restarted = new SandboxChatConversationLines(() => chat)
    await restarted.followInboundConversation(space('new'))
    expect(heads.get('k')).toBe('route:k:sandbox-space-new')

    heads.set('k', 'route:k:rUntagged')
    const again = new SandboxChatConversationLines(() => chat)
    await again.followInboundConversation(space('new'))
    await again.followInboundConversation(main)
    expect(switches).toEqual(['route:k:sandbox-space-new', 'route:k:sandbox-space-new', 'route:k:rUntagged'])
  })

  it('会话键各自成一路跟踪', async () => {
    const { chat, switches } = createChat()
    const lines = new SandboxChatConversationLines(() => chat)

    await lines.followInboundConversation({ scopeId: 'a', session: { key: 'one' } })
    await lines.followInboundConversation({ session: { key: 'two' } })
    expect(switches).toEqual(['route:one:sandbox-space-a'])
  })

  it('ChatLuna 不在或算不出会话键时静默跳过', async () => {
    let installed: ChatConversationHeads | undefined
    const lines = new SandboxChatConversationLines(() => installed)

    expect(await lines.followInboundConversation(space('a'))).toBe(false)
    installed = createChat(() => undefined).chat
    expect(await lines.followInboundConversation(space('a'))).toBe(false)
  })
})

describe('解析 v2 的 chat 与 conversations 服务', () => {
  it('按 binding 取会话键，按 current 读头会话；切换后释放仍挂在旧会话上的 agent', async () => {
    const calls: string[] = []
    const chatService = {
      prefix: 'route-key:',
      binding(this: { prefix: string }, session: { id: string }) {
        return { conversationKey: `${this.prefix}${session.id}` }
      },
    }
    const conversations = {
      heads: new Map([['k', 'route:k']]),
      async current(this: { heads: Map<string, string> }, key: string) {
        const sessionId = this.heads.get(key)
        return sessionId ? { sessionId } : undefined
      },
      async switch(this: { heads: Map<string, string> }, key: string, to: string) {
        this.heads.set(key, to)
        calls.push(`switch ${to}`)
      },
      live: (key: string) => ({ record: { sessionId: key === 'k' ? 'route:k' : 'route:other' } }),
      release: async (sessionId: string) => {
        calls.push(`release ${sessionId}`)
      },
    }
    const services: Record<string, unknown> = { chat: chatService, conversations }
    const chat = findChatConversationHeads({ get: (name: string) => services[name] })

    expect(chat?.conversationKeyOf({ id: 'a' })).toBe('route-key:a')
    expect(await chat?.head('k')).toBe('route:k')
    expect(await chat?.head('missing')).toBeUndefined()
    await chat?.switch('k', 'route:k:sandbox-space-a')
    expect(calls).toEqual(['switch route:k:sandbox-space-a', 'release route:k'])
  })

  it('形状不对时解析不出服务，而不是让派发在调用点上炸掉', () => {
    expect(findChatConversationHeads(undefined)).toBeUndefined()
    expect(findChatConversationHeads({ get: (name: string) => (name === 'chat' ? { binding() {} } : undefined) })).toBeUndefined()
    const services: Record<string, unknown> = { chat: { binding() {} }, conversations: { current: async () => undefined, switch: async () => {} } }
    expect(findChatConversationHeads({ get: (name: string) => services[name] })?.conversationKeyOf({})).toBeUndefined()
  })
})

describe('入站事件派发时切换会话', () => {
  /**
   * 假 `chat` 服务按 v2 `routeKeyOf` 的口径算会话键：私聊只看账号，群聊看 channelId。
   * 私聊实例因此与根会话同键，群实例各成一路。
   */
  async function createControls() {
    const heads = new Map<string, string>()
    const switches: string[] = []
    const chat = {
      binding(session: { selfId: string, isDirect: boolean, userId: string, channelId: string }) {
        return { conversationKey: session.isDirect ? `${session.selfId}:user:${session.userId}` : `${session.selfId}:channel:${session.channelId}` }
      },
    }
    const conversations = {
      current: async (key: string) => (heads.has(key) ? { sessionId: heads.get(key) } : undefined),
      switch: async (key: string, to: string) => {
        heads.set(key, to)
        switches.push(to)
      },
    }
    const app = new App()
    const runtimeBots = new SandboxRuntimeBotRegistry()
    let control: SandboxControlService | undefined
    let spaceControl: SandboxControlService | undefined
    app.plugin((ctx) => {
      ctx.provide('chat')
      ctx.provide('conversations')
      Reflect.set(ctx, 'chat', chat)
      Reflect.set(ctx, 'conversations', conversations)
      control = new SandboxControlService(ctx, { runtimeBots })
      // 空间与主场景同号；同一时刻只有一方运行机器人，空间先不接管。
      spaceControl = new SandboxControlService(ctx, { runtimeBots, scopeId: 'space-1', runtimeActive: false })
    })
    runningApps.push(app)
    await app.start()
    if (!control || !spaceControl) throw new Error('沙盒控制服务未注册')
    return { control, spaceControl, heads, switches }
  }

  it('私聊从根会话切到会话实例时换到实例自己的会话，切回根会话时根会话的历史还在', async () => {
    const { control, switches } = await createControls()

    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '根会话里的问题' })
    const { conversationId } = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里提问' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在实例里追问' })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '回到根会话' })

    expect(switches).toEqual([`route:20001:user:10001:sandbox-line-${conversationId}`, 'route:20001:user:10001'])
  })

  it('群实例在 v2 里本来就是另一份会话，不切换', async () => {
    const { control, switches } = await createControls()

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '群里的问题' })
    const { conversationId } = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'group:30001' })
    await control.sendMessage({ operatorId: '10001', conversationId, content: '在群实例里提问' })

    expect(switches).toEqual([])
  })

  it('测试空间里同号的群换到空间自己的会话，回到主场景再换回来', async () => {
    const { control, spaceControl, heads, switches } = await createControls()

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '主场景' })
    heads.set('20001:channel:30001', 'route:20001:channel:30001')
    control.setRuntimeActive(false)
    spaceControl.setRuntimeActive(true)
    await spaceControl.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '空间里' })
    spaceControl.setRuntimeActive(false)
    control.setRuntimeActive(true)
    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '回到主场景' })

    expect(switches).toEqual(['route:20001:channel:30001:sandbox-space-space-1', 'route:20001:channel:30001'])
  })

  it('通知与申请事件派发前同样切换，插件在回调里唤醒时落在本场景的会话上', async () => {
    const { control, spaceControl, heads, switches } = await createControls()
    heads.set('20001:user:10002', 'route:20001:user:10002')
    control.setRuntimeActive(false)
    spaceControl.setRuntimeActive(true)

    await spaceControl.performFriendAction({ action: 'poke', operatorId: '10002', targetId: '20001' })

    expect(switches).toEqual(['route:20001:user:10002:sandbox-space-space-1'])
  })
})
