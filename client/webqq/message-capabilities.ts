import type { ResolvedConversation } from '../../src/conversation-resolution'
import { readMessageCapabilities, type MessageCapabilities } from '../../src/message-capabilities'
import type { SandboxGroup, SandboxMessage } from '../../src/types'

/**
 * 消息列表的能力位投影：一条消息一份，答案全部来自共享判据 `src/message-capabilities`。
 *
 * 客户端因此不再自己推导「这条消息能做什么」，右键菜单只渲染这份答案，判定从组件搬到工作台
 * 外壳的投影里，从 `chatPaneModel` 的 interface 上就能观察到。能力位不进快照载荷：判据共享后
 * 客户端自己就能算，没有理由让每条消息在 RPC 上多带几个布尔值。
 *
 * 客户端的答案只用来渲染菜单，不构成许可——服务端在写入路径上照旧自己问一遍再拒绝。
 */
export interface MessageCapabilityProjectionInput {
  readonly messages: readonly SandboxMessage[]
  /** 当前会话；缺省表示还没有选中会话，因此没有消息可判。 */
  readonly conversation?: ResolvedConversation
  readonly operatorId?: string
  /** 群聊会话所属的群组；私聊为 undefined。 */
  readonly group?: SandboxGroup
}

export function buildMessageCapabilityMap(
  input: MessageCapabilityProjectionInput,
): Record<string, MessageCapabilities> {
  const conversation = input.conversation
  if (!conversation) return {}
  return Object.fromEntries(input.messages.map((message) => [
    message.id,
    readMessageCapabilities({
      message,
      conversation,
      operatorId: input.operatorId,
      group: input.group,
    }),
  ]))
}
