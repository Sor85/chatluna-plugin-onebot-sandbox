import { findChatLunaRuntime, readRecord } from './runtime'

/**
 * 让 ChatLuna v2 的会话跟随沙盒的对话线。
 *
 * v2 按路由键归属会话：群聊的键带 channelId，会话实例本来就各成一份；私聊的键只看账号
 * （`@chatluna/satori` 的 `routeKeyOf`），根会话与它的全部实例在 ChatLuna 那里塌成同一份会话——在新
 * 实例里发第一条消息时，模型会带着上一条对话线的历史回答，分支测试因此不成立。
 *
 * 沙盒没有办法让 v2 按实例分开归属，只能在对话线切换时经 `ctx.chat.reset` 给那个会话键换一份新会话。
 * 重置只在「同一个键上一次派发的对话线与本次不同」时发生，因此在同一条对话线里连续发消息不丢上下文。
 * 键取 v2 按这次派发的 Session 实际算出的 `conversationKey`，会话归属规则（`chat.session`）改了也跟着变；
 * 群聊实例的键各不相同，永远不会触发重置。
 *
 * 跟踪只在内存里：进程重启后第一次派发不重置，即使 v2 那份会话上次停在另一条对话线上。
 */

/** 被测 ChatLuna 的 `chat` 服务里沙盒用到的那一小块。 */
export interface ChatConversationReset {
  /** 这次派发会落到的 v2 会话键（`ctx.chat.binding(session).conversationKey`）。 */
  conversationKeyOf(session: unknown): string | undefined
  /** 给会话键换一份新会话（`ctx.chat.reset`）。 */
  reset(conversationKey: string): Promise<unknown>
}

/**
 * 解析 v2 的 `chat` 服务，理由同 {@link findChatLunaRuntime}：按名称现取，不写进 inject。
 * 同时有 `binding` 与 `reset` 才算解析成功。
 */
export function findChatConversationReset(host: unknown): ChatConversationReset | undefined {
  return findChatLunaRuntime(host, 'chat', (chat) => {
    const { binding, reset } = chat
    if (typeof binding !== 'function' || typeof reset !== 'function') return undefined
    return {
      conversationKeyOf: (session) => {
        const key = readRecord((binding as (session: unknown) => unknown).call(chat, session))?.conversationKey
        return typeof key === 'string' && key ? key : undefined
      },
      reset: async (conversationKey) => (reset as (key: string) => Promise<unknown>).call(chat, conversationKey),
    }
  })
}

export interface ChatInboundConversation {
  botId: string
  /** 这次入站事件来自哪个沙盒会话，根会话与会话实例一律用它自己的 ID。 */
  conversationId: string
  /** 即将派发给机器人的 Session；v2 按它算会话键。 */
  session: unknown
}

export class SandboxChatConversationLines {
  /** 每个（机器人，v2 会话键）上一次派发的对话线。 */
  private lastConversationIds = new Map<string, string>()

  constructor(private resolveChat: () => ChatConversationReset | undefined) {}

  /**
   * 记下这次入站事件属于哪条对话线，并在它与上一次不同时重置 v2 那份会话。返回是否真的重置过。
   *
   * 第一次为某个键派发时不重置：那份会话可能正是这条对话线攒下的历史。
   */
  async followInboundConversation(input: ChatInboundConversation): Promise<boolean> {
    const chat = this.resolveChat()
    const conversationKey = chat?.conversationKeyOf(input.session)
    if (!chat || !conversationKey) return false
    const key = `${input.botId}\u0000${conversationKey}`
    const previous = this.lastConversationIds.get(key)
    this.lastConversationIds.set(key, input.conversationId)
    if (previous === undefined || previous === input.conversationId) return false
    await chat.reset(conversationKey)
    return true
  }
}
