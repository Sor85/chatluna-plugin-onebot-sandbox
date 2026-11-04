import { isInheritedMessage as isInheritedPrefixMessage } from '../../src/conversation-resolution'
import { NO_MESSAGE_CAPABILITIES, type MessageCapabilities } from '../../src/message-capabilities'
import {
  formatRecalledMessageEventText,
  isRecalledMessage,
  type SandboxForwardPreview,
  type SandboxMedia,
  type SandboxMessage,
} from '../../src/types'
import { isForkBoundaryMessage } from './fork-boundary'
import { formatMentionContent } from './mention'

/**
 * 「这条消息该怎么显示」——消息列表的呈现判定。
 *
 * 全部是纯函数：不起组件就能逐条问，也因此每一条都能被断言。此前它们住在
 * `webqq-message-list.vue` 的 `script` 里，唯一的验证手段是把组件源码读进来断言某一行文本
 * 出现过，那证明的是「有人写过这行」，不是「撤回的消息真的不能被引用」。
 */

/** 呈现判定要读的那部分列表模型。收窄到这几项，测试不必造一整个列表模型。 */
export interface MessagePresentationContext {
  readonly replyMessages: Record<string, SandboxMessage>
  readonly forwardPreviews: Record<string, SandboxForwardPreview>
  readonly messageCapabilities: Record<string, MessageCapabilities>
  readonly participantNames: Record<string, string>
  /** 默认 true：保留撤回气泡；false：隐藏原文并显示结构化撤回事件。 */
  readonly markRecalledMessages: boolean
  readonly currentConversationId?: string
  readonly currentOperatorId?: string
}

/** 媒体类型在界面上的中文标签。合并转发预览与消息气泡共用这一份。 */
export function getMediaLabel(media: Pick<SandboxMedia, 'type'>): string {
  return media.type === 'image' ? '图片'
    : media.type === 'audio' ? '语音'
      : media.type === 'video' ? '视频'
        : '文件'
}

/** 文件消息上的体积文案。1024 进制，KB 与 MB 保留一位小数。 */
export function formatMediaSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 事件化：这一行渲染成一条居中的系统提示，而不是一个气泡。
 *
 * 两种来源——戳一戳这类本来就是事件的消息，以及关闭了撤回标记时的撤回消息。开启撤回标记时
 * 撤回消息仍然渲染原气泡并弱化，因此这里必须同时看消息与设置，只看其中一个都会错。
 */
export function shouldRenderAsEvent(
  message: SandboxMessage,
  context: Pick<MessagePresentationContext, 'markRecalledMessages'>,
): boolean {
  return !!message.event || (isRecalledMessage(message) && !context.markRecalledMessages)
}

/** 事件行上的文案。撤回事件按操作者渲染，其余事件直接用消息正文。 */
export function getEventMessageText(
  message: SandboxMessage,
  resolveOperatorName: (participantId: string) => string,
): string {
  if (isRecalledMessage(message)) {
    const operatorId = message.lifecycle?.operatorId ?? message.authorId
    return formatRecalledMessageEventText(message, resolveOperatorName(operatorId))
  }
  return message.content
}

/** 思考内容归档在消息上，因此多轮对话后每条机器人消息都保留自己的那一份。 */
export function getMessageThinking(message: SandboxMessage) {
  return message.chatLuna?.thought ? message.chatLuna : undefined
}

/** 没有思考内容但拿到了 Token 用量时单独常显指标。 */
export function getMessageUsage(message: SandboxMessage) {
  const chatLuna = message.chatLuna
  return chatLuna && !chatLuna.thought && chatLuna.usage ? chatLuna : undefined
}

/**
 * 思考与用量随撤回标记一同隐藏。
 *
 * 关闭撤回标记时原文已经被换成事件行，思考与用量若还留着就等于把撤回掉的内容又露出来一次。
 */
export function shouldShowThinking(
  message: SandboxMessage,
  context: Pick<MessagePresentationContext, 'markRecalledMessages'>,
): boolean {
  return !!getMessageThinking(message) && !(isRecalledMessage(message) && !context.markRecalledMessages)
}

export function shouldShowUsage(
  message: SandboxMessage,
  context: Pick<MessagePresentationContext, 'markRecalledMessages'>,
): boolean {
  return !!getMessageUsage(message) && !(isRecalledMessage(message) && !context.markRecalledMessages)
}

/**
 * 气泡里显示的正文。
 *
 * 两处返回空串：外层合并转发卡片自己渲染预览行，正文再显示一次会和摘要重复；单媒体消息的正文
 * 若恰好就是服务端生成的「[标签] 文件名」，气泡里已经有那个文件本身，重复一遍是噪音。
 * 去重按逐字相等判定——用户手写的同样内容也会被去掉，但那是同一句话说两遍。
 */
export function getMessageText(
  message: SandboxMessage,
  context: Pick<MessagePresentationContext, 'participantNames'>,
): string {
  if (message.forwardId) return ''
  const media = message.media
  if (media?.length === 1 && message.content === `[${getMediaLabel(media[0]!)}] ${media[0]!.name}`) return ''
  return formatMentionContent(message.content, context.participantNames)
}

/** 引用回复的被引消息。查表拿，取不到就当没有引用。 */
export function getReplyMessage(
  message: SandboxMessage,
  context: Pick<MessagePresentationContext, 'replyMessages'>,
): SandboxMessage | undefined {
  return message.replyToMessageId ? context.replyMessages[message.replyToMessageId] : undefined
}

/**
 * 合并转发卡片的预览。
 *
 * 先看消息自己有没有转发标识，再查表：只查表会让「预览表里恰好有同名条目」的消息误显示成
 * 转发卡片。预览缺失时卡片仍然渲染但入口禁用——资源还在加载，不是没有。
 */
export function getForwardPreview(
  message: SandboxMessage,
  context: Pick<MessagePresentationContext, 'forwardPreviews'>,
): SandboxForwardPreview | undefined {
  return message.forwardId ? context.forwardPreviews[message.id] : undefined
}

/** 打开合并转发的入参；缺转发标识或预览未就绪时返回 undefined，表示这一下不该有反应。 */
export function resolveForwardOpenInput(
  message: SandboxMessage,
  context: Pick<MessagePresentationContext, 'forwardPreviews'>,
): { messageId: string, forwardId: string } | undefined {
  if (!message.forwardId || !getForwardPreview(message, context)) return
  return { messageId: message.id, forwardId: message.forwardId }
}

/**
 * 这条消息现在能做什么。
 *
 * 判定住在 `src/message-capabilities`，服务端在写入路径上问的是同一份判据；这里只读答案，
 * 因此右键里出现的动作都真的做得到，也不会长出第二份口径。投影还没给出这条消息时一律读作
 * 「一条都做不到」，不猜。
 */
export function readMessageCapabilities(
  message: Pick<SandboxMessage, 'id'>,
  context: Pick<MessagePresentationContext, 'messageCapabilities'>,
): MessageCapabilities {
  return context.messageCapabilities[message.id] ?? NO_MESSAGE_CAPABILITIES
}

/**
 * 消息是不是这条分支继承来的那一段。
 *
 * 判定住在共享的 `isInheritedMessage`：同一份判定既决定这一行要不要弱化，也是消息能力里
 * 「继承前缀在实例视图里只读」那一条的依据，因此右键里做不到的动作干脆不显示。
 */
export function isInheritedMessage(
  message: SandboxMessage,
  context: Pick<MessagePresentationContext, 'currentConversationId'>,
): boolean {
  return isInheritedPrefixMessage(message, context.currentConversationId)
}

/** 这一行之前要不要画分界：它解释了上面那段为什么右键项更少。 */
export function isForkBoundary(
  messages: readonly SandboxMessage[],
  index: number,
  context: Pick<MessagePresentationContext, 'currentConversationId'>,
): boolean {
  return isForkBoundaryMessage(messages, index, context.currentConversationId)
}

/**
 * 点一下已有回应条要不要生效，以及生效时是贴上还是取消。
 *
 * 两道闸门缺一不可：能力位管「这条消息还允不允许被贴」，当前操作者管「是谁在贴」。少一道
 * 就会让用户点一下已有 emoji 绕过只读，或者在没有操作者时贴出一条无主回应。
 */
export function resolveReactionToggle(
  message: SandboxMessage,
  emojiId: string,
  context: Pick<MessagePresentationContext, 'messageCapabilities' | 'currentOperatorId'>,
): { messageId: string, emojiId: string, enabled: boolean } | undefined {
  const operatorId = context.currentOperatorId
  if (!readMessageCapabilities(message, context).react || !operatorId) return
  const reaction = message.reactions?.find((item) => item.emojiId === emojiId)
  return {
    messageId: message.id,
    emojiId,
    enabled: !reaction?.participantIds.includes(operatorId),
  }
}
