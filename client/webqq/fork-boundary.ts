import { isInheritedMessage } from '../../src/conversation-resolution'
import type { SandboxMessage } from '../../src/types'

/**
 * 分支视图里继承前缀与自有消息的边界。
 *
 * 判定依据只有「消息自己的归属会话」，由 {@link isInheritedMessage} 在共享模块里给出：投影出的
 * 消息带着它真正所属的那个会话，与当前会话不同的就是继承前缀——它是与原会话共享的同一份记录，
 * 不需要额外字段，也不需要客户端再沿来源链拼一次。
 */

/**
 * 这一条是不是继承前缀之后的第一条自有消息，也就是该显示分界标记的位置。
 *
 * 分界画在两段之间，因此它挂在自有消息那一侧：挂在前缀最后一条上会在「前缀被清空或被保留窗口
 * 淘汰后整段变空」时连分界一起消失，而分支本身还在。根会话与没有继承前缀的实例因此都不画分界。
 */
export function isForkBoundaryMessage(
  messages: readonly SandboxMessage[],
  index: number,
  currentConversationId: string | undefined,
) {
  const message = messages[index]
  const previous = messages[index - 1]
  if (!message || !previous) return false
  return !isInheritedMessage(message, currentConversationId)
    && isInheritedMessage(previous, currentConversationId)
}
