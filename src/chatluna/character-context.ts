import { findChatLunaRuntime } from './runtime'
import type { ResolvedConversation } from '../conversation-resolution'

/**
 * 让被测 chatluna-character 的对话上下文跟随沙盒的对话线。
 *
 * chatluna-character 把消息缓冲、状态与历史回填全部按 `private:<账号>` 或 `group:<群号>` 归档，
 * 完全不看 channelId。沙盒的会话实例只在 channelId 这一维上与根会话不同，因此一个根会话与它
 * 的全部实例在被测插件那里塌成同一份上下文——在新实例里发第一条消息时，`history_new` 会带着
 * 上一条对话线的历史进模型，分支测试因此不成立。
 *
 * 沙盒没有办法让第三方插件同时持有多份上下文，只能在对话线切换时把它那份重置掉。重置只在
 * 「同一个键上一次派发的会话与本次不同」时发生，因此在同一条对话线里连续发消息不丢上下文。
 *
 * 形态是「一个跟踪器加一个解析函数」而不是直接持有服务引用：被测插件可以随时重载，解析必须
 * 每次现取。跟踪器自己不认识 Koishi，因此这条规则可以脱离运行时验证。
 */

const SERVICE_NAME = 'chatluna_character'

/** 被测 chatluna-character 服务里沙盒真正用到的那一小块。 */
export interface ChatLunaCharacterChatContext {
  /** 清空某个会话键下的消息缓冲、状态与历史回填水位。 */
  clear(sessionKey?: string, force?: boolean): unknown
}

/**
 * chatluna-character 归档一次对话上下文用的键：私聊按发言者账号，群聊按群号。
 *
 * 这是复述第三方实现的一处形状，不是沙盒自己的领域概念。它只在本模块出现一次，键的写法与
 * 被测插件对不上时也只需要改这一处。
 */
export function resolveChatLunaCharacterSessionKey(
  conversation: Pick<ResolvedConversation, 'type' | 'groupId'>,
  authorId: string,
): string {
  return conversation.type === 'group' ? `group:${conversation.groupId}` : `private:${authorId}`
}

/**
 * 解析被测 chatluna-character 服务。
 *
 * 「怎么取到被测插件的服务」由 `chatluna-runtime` 持有：走 `get(name)` 而不是属性访问、自己的上下文
 * 取不到时用提供方自己的上下文再取一次，两条的理由都写在那里。本模块只声明自己要的那一小块能力——
 * 能清空会话上下文的服务才算解析成功，形状不对时当作没装，而不是等到真要重置时在调用点上炸掉。
 */
export function findChatLunaCharacterChatContext(host: unknown): ChatLunaCharacterChatContext | undefined {
  return findChatLunaRuntime(host, SERVICE_NAME, (service) => (
    typeof service.clear === 'function' ? service as unknown as ChatLunaCharacterChatContext : undefined
  ))
}

export interface ChatLunaCharacterInboundConversation {
  botId: string
  /** {@link resolveChatLunaCharacterSessionKey} 的结果。 */
  sessionKey: string
  /** 这次入站事件来自哪个沙盒会话，根会话与会话实例一律用它自己的 ID。 */
  conversationId: string
}

export class SandboxChatLunaCharacterContext {
  /** 每个（机器人，会话键）上一次派发的对话线。分隔符只需与两段取值都不冲突。 */
  private lastConversationIds = new Map<string, string>()

  constructor(private resolveChatContext: () => ChatLunaCharacterChatContext | undefined) {}

  /**
   * 记下这次入站事件属于哪条对话线，并在它与上一次不同时重置被测插件那份上下文。
   * 返回是否真的重置过。
   *
   * 本进程第一次为某个键派发时不重置：那一刻插件那份上下文还没被别的对话线污染过，而重置会
   * 在插件里写下一条历史截断时间，之后它再也回填不出这条对话线自己的历史。让它照常按沙盒的
   * 历史查询冷回填，读到的正是这条对话线的历史。
   */
  async followInboundConversation(input: ChatLunaCharacterInboundConversation): Promise<boolean> {
    const key = `${input.botId}|${input.sessionKey}`
    const previous = this.lastConversationIds.get(key)
    this.lastConversationIds.set(key, input.conversationId)
    if (previous === undefined || previous === input.conversationId) return false
    const chatContext = this.resolveChatContext()
    if (!chatContext) return false
    await chatContext.clear(input.sessionKey)
    return true
  }
}
