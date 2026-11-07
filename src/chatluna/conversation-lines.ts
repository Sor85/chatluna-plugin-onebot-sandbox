import { findChatLunaRuntime, readRecord } from './runtime'

/**
 * 让 ChatLuna v2 的会话跟随沙盒的对话线。
 *
 * v2 按路由键归属会话，键只由平台、机器人 selfId 与群号（私聊是对方账号）组成（`@chatluna/satori` 的
 * `routeKeyOf`）。沙盒的 channelId 与 adapter-onebot 一致，于是有两处会塌成同一份会话：
 *
 * - 测试空间与主场景、空间与空间之间：群号、账号、机器人号都可能相同，新空间的群会接着上一个空间的历史聊；
 * - 私聊根会话与它的会话实例：私聊的键只看账号，分支测试里模型会带着另一条对话线的历史回答。
 *
 * 沙盒不改 channelId，而是在派发前把这个键的头会话（`ctx.conversations` 的 head）切到本条对话线自己的
 * ChatLuna 会话上：主场景的根会话用 v2 默认的 `route:<键>`，升级前攒下的历史原样保留；其余对话线用
 * 固定后缀 `route:<键>:sandbox-space-<空间 ID>:sandbox-line-<实例 ID>`（按需取其中一段），
 * 重启后同一条对话线仍回到同一份会话，新空间则必然是一份新会话。群实例的 channelId 是实例 ID，
 * 本来就各成一键，所以只有私聊实例带 line 段。
 *
 * 归属跟踪由所有场景共用（主场景与各测试空间同一个实例），只在内存里：同一次运行中，某条对话线上被
 * v2 自己重置（用户清空会话）换成的新会话会被记住，切走再切回仍是它。重启后无法得知不带后缀的头会话
 * 属于谁，按主场景根会话处理——测试空间与私聊实例永远不会接手它。
 */

/** 沙盒用到的那一小块 v2 运行时：`chat` 算会话键，`conversations` 读写头会话。 */
export interface ChatConversationHeads {
  /** 这次派发会落到的 v2 会话键（`ctx.chat.binding(session).conversationKey`）。 */
  conversationKeyOf(session: unknown): string | undefined
  /** 会话键当前的头会话 ID；会话还没建立时为 undefined。 */
  head(conversationKey: string): Promise<string | undefined>
  /** 把头会话切到指定会话，并释放仍挂在旧头会话上的 agent，下一次派发按新头会话打开。 */
  switch(conversationKey: string, sessionId: string): Promise<void>
}

/** 与 `@chatluna/satori` 的 `sessionIdFor` 一致：会话键第一次建立时的头会话。 */
export function defaultChatSessionId(conversationKey: string): string {
  return `route:${conversationKey}`
}

const LINE_TAG = 'sandbox-'

/** 一条对话线：所在作用域（测试空间 ID，主场景为空）与私聊会话实例 ID（根会话为空）。 */
export interface ChatConversationLine {
  scopeId?: string
  instanceId?: string
}

/** 对话线自己的 ChatLuna 会话 ID：主场景根会话是 v2 默认值，其余带固定后缀。 */
export function chatSessionIdOf(conversationKey: string, line: ChatConversationLine): string {
  return [
    defaultChatSessionId(conversationKey),
    ...(line.scopeId ? [`${LINE_TAG}space-${line.scopeId}`] : []),
    ...(line.instanceId ? [`${LINE_TAG}line-${line.instanceId}`] : []),
  ].join(':')
}

/**
 * 解析 v2 的 `chat` 与 `conversations` 服务，理由同 {@link findChatLunaRuntime}：按名称现取，不写进 inject。
 * 两者形状都对才算解析成功。
 */
export function findChatConversationHeads(host: unknown): ChatConversationHeads | undefined {
  const chat = findChatLunaRuntime(host, 'chat', (service) => (typeof service.binding === 'function' ? service : undefined))
  const conversations = findChatLunaRuntime(host, 'conversations', (service) => (
    typeof service.current === 'function' && typeof service.switch === 'function' ? service : undefined
  ))
  if (!chat || !conversations) return
  const call = <T>(name: string, ...args: unknown[]) => (conversations[name] as (...args: unknown[]) => T).call(conversations, ...args)
  return {
    conversationKeyOf: (session) => {
      const key = readRecord((chat.binding as (session: unknown) => unknown).call(chat, session))?.conversationKey
      return typeof key === 'string' && key ? key : undefined
    },
    head: async (conversationKey) => {
      const sessionId = readRecord(await call<Promise<unknown>>('current', conversationKey))?.sessionId
      return typeof sessionId === 'string' && sessionId ? sessionId : undefined
    },
    // 与 `ctx.chat.reset` 相同的两步：先移动持久的头会话，再释放旧 agent，期间到达的消息按新头会话解析。
    switch: async (conversationKey, sessionId) => {
      await call<Promise<void>>('switch', conversationKey, sessionId)
      if (typeof conversations.live !== 'function' || typeof conversations.release !== 'function') return
      const live = readRecord(call<unknown>('live', conversationKey))
      const liveSessionId = readRecord(live?.record)?.sessionId
      if (liveSessionId !== undefined && String(liveSessionId) !== sessionId) await call<Promise<void>>('release', String(liveSessionId))
    },
  }
}

export interface ChatInboundConversation extends ChatConversationLine {
  /** 即将派发给机器人的 Session；v2 按它算会话键。 */
  session: unknown
}

function lineKeyOf(line: ChatConversationLine): string {
  return `${line.scopeId ?? ''}\u0000${line.instanceId ?? ''}`
}

const MAIN_ROOT_LINE = lineKeyOf({})

export class SandboxChatConversationLines {
  /** v2 会话键 → 当前占着它的对话线。 */
  private owners = new Map<string, string>()
  /** （对话线，v2 会话键）→ 这条对话线上次停留的会话；v2 自己重置过时与固定 ID 不同。 */
  private sessions = new Map<string, string>()
  /** 同一个会话键上的切换串行执行，连发的消息不会交错读写头会话。 */
  private pending = new Map<string, Promise<unknown>>()

  constructor(private resolveChat: () => ChatConversationHeads | undefined) {}

  /** 在派发前把 v2 会话切到这次入站事件所属的对话线上。返回是否真的切换过。 */
  async followInboundConversation(input: ChatInboundConversation): Promise<boolean> {
    const chat = this.resolveChat()
    const conversationKey = chat?.conversationKeyOf(input.session)
    if (!chat || !conversationKey) return false
    const previous = this.pending.get(conversationKey) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.follow(chat, conversationKey, input))
    this.pending.set(conversationKey, run)
    try {
      return await run
    } finally {
      if (this.pending.get(conversationKey) === run) this.pending.delete(conversationKey)
    }
  }

  private async follow(chat: ChatConversationHeads, conversationKey: string, line: ChatConversationLine): Promise<boolean> {
    const lineKey = lineKeyOf(line)
    const slot = (key: string) => `${key}\u0000${conversationKey}`
    const head = await chat.head(conversationKey)
    const owner = this.owners.get(conversationKey)
    if (owner === lineKey) {
      if (head) this.sessions.set(slot(lineKey), head)
      return false
    }
    // 记下切走的那条线停在哪份会话上。不知道归属的头会话只可能是主场景根会话的：
    // 带后缀的会话 ID 由它自己的对话线按固定 ID 找回，不必记。
    if (head && owner !== undefined) this.sessions.set(slot(owner), head)
    else if (head && !head.startsWith(`${defaultChatSessionId(conversationKey)}:${LINE_TAG}`)) this.sessions.set(slot(MAIN_ROOT_LINE), head)
    this.owners.set(conversationKey, lineKey)
    const target = this.sessions.get(slot(lineKey)) ?? chatSessionIdOf(conversationKey, line)
    if (head === target || (head === undefined && target === defaultChatSessionId(conversationKey))) return false
    await chat.switch(conversationKey, target)
    return true
  }
}
