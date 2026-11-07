import { Random } from './random'
import { Universal, h } from '@satorijs/core'
import type { SandboxChannelAssigneeTarget } from './channel-assignee'
import type { ChatInboundConversation } from './chatluna/conversation-lines'
import { toOneBotChannelId, type ResolvedConversation } from './conversation-resolution'
import { createOneBotDebugError, type AppendOneBotDebugRecordInput } from './onebot-debug'
import { toOneBotRawMessage, type SandboxOneBotMessageSegment } from './onebot-message'
import { getOneBotMessageEventFields, getOneBotMessageId, getOneBotMessageSequence, getSatoriMessageId } from './onebot-profiles'
import {
  SandboxDomainError,
  type SandboxBotDelivery,
  type SandboxBotProfile,
  type SandboxGroup,
  type SandboxParticipant,
} from './types'

/**
 * 入站投递：把一条已落库的消息投递给所有该收到它的虚拟 OneBot 机器人。
 *
 * 在此之前发文字、发图片、发合并转发三条路各自组装一份几乎相同的投递数据再交给同一个派发
 * 函数，修好一条不代表另两条也修好了；而投递里有五条改坏了不报错的规则（中间件等待的超时、
 * ChatLuna 角色上下文跟随失败不中断投递、入站事件会话的进出栈、派发之前失败也要留痕、群聊要先
 * 对齐 Koishi channel 受理人）藏在一个三千行的控制服务里，要驱动它们得先起一个真的 Koishi
 * 运行时。本模块把投递规则收成一处，并让那五条第一次有红灯。
 *
 * 协作者按最小结构化 interface 注入，**不注入宿主 `Context`**：按标识取运行时机器人、按标识取
 * 机器人档案、订阅中间件完成、写调试记录、写投递记录、跟随角色上下文、记日志。因此接收机器人
 * 推导、中间件超时、跟随失败与入站事件会话都能不开 Koishi 运行时驱动。
 *
 * 它是服务端专用，可以自由依赖 Koishi 运行时类型。
 */

/**
 * 等被测插件的中间件链结束最多等这么久。
 *
 * Koishi 的 `dispatch()` 是同步触发事件、异步执行中间件；等待 middleware 完成才能保证控制台 RPC
 * 返回时，插件通过 `session.send()` 写入的回复已可见。ChatLuna 等长耗时中间件可能永不触发同
 * session 的 middleware 结束事件，或阻塞在外部请求上；无超时会让 void 掉的投递 Promise 永久挂起，
 * 堆积监听器并拖垮运行时。
 *
 * 时长不做成注入项：需要在测试里推过它的用测试运行器的假时钟，而不是换一个时钟。
 */
export const INBOUND_MIDDLEWARE_TIMEOUT_MS = 15_000

/** 运行时机器人在投递里被用到的那一小片：造一个会话、把它派发出去。 */
export interface InboundDeliveryBot {
  readonly selfId: string
  session(event: Partial<Universal.Event>): InboundDeliverySession
  dispatch(session: InboundDeliverySession): void | Promise<void>
}

/**
 * 会话在投递里只被读一个字段：中间件完成事件按它配对，判断这次结束的是不是本次派发。
 *
 * 原始 OneBot 载荷不在这份形状里，因为它不是会话自己的字段——沙盒把它嫁接在第三方 `Session`
 * 实例上（`Object.assign(session, { onebot })`），被测插件读的也正是那个嫁接上去的属性。
 * 因此 {@link InboundDelivery.dispatchEvent} 反射读它：声明成本 interface 的字段会假装沙盒
 * 拥有会话的形状，而那五个 notice／request 事件的载荷是控制服务自己嫁接的，不经本模块。
 */
export interface InboundDeliverySession {
  readonly id: number
}

export interface InboundDeliveryLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * 每个虚拟 OneBot 机器人当前正在处理的入站消息事件来自哪个会话，按嵌套顺序入栈。
 *
 * 写入落点不看它，只观察：原始 OneBot action 的回复仍然落到根会话。读取跟随它：原始历史查询按
 * 来源会话作答，否则插件在会话实例里会读到另一条对话线的历史并静默拿去请求模型。
 * 窗口从事件派发开始到该事件的中间件链结束，也就是插件真正有机会回复的那段时间；事件派发之后
 * 异步发出的 action 不在窗口内，因此不会被归因，这是有意的下限而不是遗漏。
 *
 * 它与投递模块分开成一个值：机器人适配器要读它，而投递模块只有两件对外的事，把读取塞进那份
 * interface 会让「派发一个事件」「投递一条消息」之外多出第三件。
 */
export interface InboundEventConversations {
  /** 某个机器人此刻正在处理的入站消息事件来自哪个会话；不在处理入站事件时为 undefined。嵌套派发取最内层。 */
  current(botId: string): string | undefined
  /** 在窗口内执行一次派发；无论成败都出栈。 */
  run<T>(botId: string, conversationId: string, dispatch: () => Promise<T>): Promise<T>
}

export function createInboundEventConversations(): InboundEventConversations {
  const stacks = new Map<string, string[]>()
  return {
    current: (botId) => stacks.get(botId)?.at(-1),

    async run(botId, conversationId, dispatch) {
      const stack = stacks.get(botId) ?? []
      if (!stack.length) stacks.set(botId, stack)
      stack.push(conversationId)
      try {
        return await dispatch()
      } finally {
        // 按值删除而不是 pop()：同一机器人上并发派发时出栈顺序不保证与入栈顺序相反。
        const index = stack.lastIndexOf(conversationId)
        if (index >= 0) stack.splice(index, 1)
        if (!stack.length) stacks.delete(botId)
      }
    },
  }
}

/**
 * 一次入站消息投递所处的领域位置。
 *
 * 只要求投递真正读到的那几项。控制服务的消息上下文多带一个引用目标，它是发送路径自己组装消息段
 * 时用的，投递按 {@link DeliverInboundMessageInput.quote} 收到已经解析好的引用。
 */
export interface InboundMessageContext {
  readonly operator: SandboxParticipant
  readonly peer?: SandboxParticipant
  readonly conversation: ResolvedConversation
  readonly group?: SandboxGroup
}

/** 会话里的引用回复。由调用方解析：它要按作者标识查参与者，而参与者集合归场景所有。 */
export interface InboundQuotedMessage {
  id: string
  messageId: string
  content: string
  elements: ReturnType<typeof h>[]
  timestamp: number
  user: { id: string; name?: string; isBot: boolean }
}

export interface DeliverInboundMessageInput {
  readonly context: InboundMessageContext
  readonly messageId: string
  /** Koishi 侧的消息元素。三条发送路径各自组装：文字、媒体与合并转发的正文表达本来就不同。 */
  readonly elements: ReturnType<typeof h>[]
  /** OneBot 侧的消息段，与 {@link rawMessage} 是同一份内容的两种表达。 */
  readonly segments: SandboxOneBotMessageSegment[]
  readonly rawMessage: string
  readonly quote?: InboundQuotedMessage
  /** 被回复消息的沙盒 ID；回复段里的 message_id 要按接收机器人的实现重新给出。 */
  readonly replyToMessageId?: string
}

export interface InboundDeliveryInput {
  /** 按标识取运行时机器人；取不到时投递按「机器人运行时不存在」失败。 */
  getRuntimeBot(botId: string): InboundDeliveryBot | undefined
  /** 按标识取虚拟 OneBot 机器人档案；标识不属于机器人时返回 undefined。 */
  getBotProfile(botId: string): SandboxBotProfile | undefined
  /** 订阅「某次派发的中间件链已结束」，返回解除订阅。 */
  onMiddlewareFinished(listener: (session: InboundDeliverySession) => void): () => void
  /** 追加一条 OneBot 调试记录。 */
  recordDebug(input: AppendOneBotDebugRecordInput): void
  /** 追加一条机器人事件投递记录。 */
  recordDelivery(delivery: SandboxBotDelivery): void
  /** 让 ChatLuna v2 的会话跟上这次入站事件的对话线；抛错由本模块吸收。 */
  followInboundConversation(input: ChatInboundConversation): Promise<unknown>
  /**
   * 把这条群聊会话的 Koishi channel 受理人对齐到收件机器人；抛错由本模块吸收。
   *
   * 见 {@link SandboxChannelAssignee}：受理人对不上时 Koishi 会在任何中间件之前静默丢弃非 @ 消息。
   */
  alignChannelAssignee(input: SandboxChannelAssigneeTarget): Promise<unknown>
  readonly logger: InboundDeliveryLogger
  readonly eventConversations: InboundEventConversations
}

/**
 * 对外只有两件事。
 *
 * 共用底座（派发一个事件并记录它）必须在这里：六种事件都用它，而它拥有调试记录的形状。留在
 * 控制服务会让本模块反过来注入一个「怎么记录一次派发」的回调，等于把自己的核心职责外包出去。
 */
export interface InboundDelivery {
  /**
   * 把一个 OneBot 事件派发给一个机器人并记录它。
   *
   * 消息、好友请求、好友通知、群请求、群通知、撤回通知六种事件都经它。失败时记一条错误记录
   * 并原样抛出——失败不被吞掉。
   */
  dispatchEvent(bot: InboundDeliveryBot, session: InboundDeliverySession): Promise<void>
  /**
   * 把一条已落库的消息投递给所有该收到它的机器人。
   *
   * 包含接收机器人推导、会话与 OneBot 事件字段构造、ChatLuna 会话跟随对话线、中间件等待与超时、
   * 入站事件会话的进出栈、投递记录。任何一步失败都会留下一条 `status: 'error'` 的调试记录与一行
   * 日志再抛出，因此调用方可以放心不等待这个 Promise。
   */
  deliverMessage(input: DeliverInboundMessageInput): Promise<void>
}

export function createInboundDelivery({
  getRuntimeBot,
  getBotProfile,
  onMiddlewareFinished,
  recordDebug,
  recordDelivery,
  followInboundConversation,
  alignChannelAssignee,
  logger,
  eventConversations,
}: InboundDeliveryInput): InboundDelivery {
  /**
   * 谁该收到这条消息。
   *
   * 消息本体只记录作者和逻辑会话；接收机器人必须在投递时按当前关系推导，才能让一条群消息复用
   * 同一个 ID 派发给多个机器人，并避免成员变更留下过期归属。
   */
  const resolveRecipientBots = (context: InboundMessageContext): SandboxBotProfile[] => {
    if (context.conversation.type === 'direct') {
      return context.peer?.kind === 'bot' && context.peer.enabled ? [context.peer] : []
    }
    return (context.group?.members ?? [])
      .map(({ participantId }) => getBotProfile(participantId))
      .filter((profile): profile is SandboxBotProfile => !!profile
        && profile.enabled
        && profile.id !== context.operator.id)
  }

  const dispatchEvent: InboundDelivery['dispatchEvent'] = async (bot, session) => {
    const startedAt = Date.now()
    const payload = Reflect.get(session, 'onebot')
    const profile = getBotProfile(bot.selfId)
    if (!profile) throw new SandboxDomainError(`机器人不存在：${bot.selfId}`)
    const type = getOneBotEventType(payload)
    try {
      await bot.dispatch(session)
      recordDebug({
        botId: bot.selfId,
        implementation: profile.implementation,
        direction: 'event',
        requestedAction: type,
        action: type,
        status: 'success',
        durationMs: Date.now() - startedAt,
        payload,
        result: { delivered: true },
      })
    } catch (error) {
      const debugError = createOneBotDebugError(error)
      logger.error(`OneBot 原始事件派发失败 [${debugError.traceId}]`, error)
      recordDebug({
        botId: bot.selfId,
        implementation: profile.implementation,
        direction: 'event',
        requestedAction: type,
        action: type,
        status: 'error',
        durationMs: Date.now() - startedAt,
        payload,
        error: debugError,
      })
      throw error
    }
  }

  /**
   * 让 ChatLuna v2 的会话跟上这次入站事件所属的对话线。
   *
   * 失败只写日志：重置不成功最坏是这一轮带上另一条对话线的历史，而中断投递会让被测插件
   * 根本收不到消息，那比上下文不干净严重得多。
   */
  const followChatConversation = async (botId: string, context: InboundMessageContext, session: unknown): Promise<void> => {
    try {
      await followInboundConversation({ botId, conversationId: context.conversation.id, session })
    } catch (error) {
      logger.warn('重置 ChatLuna 会话失败；这一轮可能带上另一条对话线的历史。', error)
    }
  }

  /**
   * 让这条群聊会话的 Koishi channel 受理人对齐到收件机器人。
   *
   * 失败只写日志：对齐是为了让消息能进中间件，对不上的后果是这条消息被 Koishi 丢掉——和不做对齐
   * 时的现状一样；而因为一次数据库写失败就中断投递，会把「可能收不到」升级成「一定收不到」。
   * 私聊不做：Koishi 那道门只在群聊生效，私聊上写 channel 行是凭空造状态。
   */
  const alignInboundChannel = async (botId: string, context: InboundMessageContext): Promise<void> => {
    if (!context.group) return
    try {
      await alignChannelAssignee({ botId, channelId: toOneBotChannelId(context.conversation, botId), groupId: context.group.id })
    } catch (error) {
      logger.warn('对齐 Koishi channel 受理人失败；这条会话可能只有 @ 消息能被被测插件收到。', error)
    }
  }

  /**
   * 派发之前就失败时补上的那条记录，与 {@link InboundDelivery.dispatchEvent} 的错误记录同形。
   *
   * 必须有这一条：`dispatchEvent` 只覆盖 `bot.dispatch()` 自己的失败，而控制台的发送监听器为了让
   * 消息即时显示不等待投递、直接吞掉这个 Promise。取不到运行时机器人、造不出会话、解析不了引用
   * 都发生在那之前，少了这条记录就会得到一次三处无痕的失败：日志没有、调试记录没有、前端也不报错，
   * 只剩一条永远不会有回复的消息气泡，而那是最难查的一种形态。
   */
  const recordPreDispatchFailure = (
    recipientBot: SandboxBotProfile,
    payload: unknown,
    startedAt: number,
    error: unknown,
  ): void => {
    const debugError = createOneBotDebugError(error)
    logger.error(`入站消息投递在派发之前失败 [${debugError.traceId}]`, error)
    const type = getOneBotEventType(payload)
    recordDebug({
      botId: recipientBot.id,
      implementation: recipientBot.implementation,
      direction: 'event',
      requestedAction: type,
      action: type,
      status: 'error',
      durationMs: Date.now() - startedAt,
      payload,
      error: debugError,
    })
  }

  const deliverToBot = async (
    recipientBot: SandboxBotProfile,
    { context, messageId, elements, segments: sourceSegments, rawMessage: sourceRawMessage, quote, replyToMessageId }: DeliverInboundMessageInput,
  ): Promise<void> => {
    const startedAt = Date.now()
    // 调用方按消息序号组装回复段，NapCat 与 LLBot 原样可用；SnowLuma 的 message_id 是哈希值，换掉回复段并重算 raw_message。
    const replyId = replyToMessageId ? getOneBotMessageId(recipientBot.implementation, replyToMessageId) : undefined
    const localized = replyToMessageId && replyId !== getOneBotMessageSequence(replyToMessageId)
    const segments = localized
      ? sourceSegments.map((segment) => segment.type === 'reply' ? { ...segment, data: { ...segment.data, id: String(replyId) } } : segment)
      : sourceSegments
    const rawMessage = localized ? toOneBotRawMessage(segments) : sourceRawMessage
    // 载荷先于运行时机器人构造：它只依赖已落库的消息与收件机器人，因此「取不到运行时」这类派发前
    // 失败也能带着完整载荷进调试记录，而不是只留一句话，看记录的人照样知道那条消息是什么。
    const payload = {
      time: Math.floor(Date.now() / 1000),
      self_id: Number(recipientBot.id),
      post_type: 'message',
      message_type: context.conversation.type === 'group' ? 'group' : 'private',
      sub_type: context.conversation.type === 'group' ? 'normal' : 'friend',
      ...getOneBotMessageEventFields(recipientBot.implementation, messageId),
      user_id: Number(context.operator.id),
      group_id: context.group ? Number(context.group.id) : undefined,
      message: segments,
      raw_message: rawMessage,
      sender: { user_id: Number(context.operator.id), nickname: context.operator.name },
    }
    // 派发已经发生过时不再补记：`dispatchEvent` 记过它那一段的失败，两处都记会让同一次失败出现两条。
    let dispatched = false
    let disposeMiddlewareWait: (() => void) | undefined
    try {
      const runtimeBot = getRuntimeBot(recipientBot.id)
      if (!runtimeBot) throw new SandboxDomainError(`机器人运行时不存在：${recipientBot.id}`)
      // 受理人与会话跟随都必须在派发之前：受理人对不上时 Koishi 连中间件都不会跑，会话不跟随时
      // ChatLuna 会带上另一条对话线的历史。两者都不阻断投递，失败各自只留一行日志。
      await alignInboundChannel(recipientBot.id, context)
      // ChatLuna allowQuoteReply / character 只认 session.quote.user.id === bot.userId|selfId，
      // 不依赖 @。quote 必须带齐 user 与 timestamp，character 才能拼出和真 QQ 一样的引用 XML。
      const session = runtimeBot.session({
        type: 'message',
        timestamp: Date.now(),
        user: { id: context.operator.id, name: context.operator.name },
        channel: {
          id: toOneBotChannelId(context.conversation, recipientBot.id),
          type: context.conversation.type === 'group' ? 0 : 1,
        },
        guild: context.group ? { id: context.group.id, name: context.group.name } : undefined,
        message: {
          id: getSatoriMessageId(recipientBot.implementation, messageId),
          messageId: getSatoriMessageId(recipientBot.implementation, messageId),
          content: elements.join(''),
          elements,
          // 引用的消息 ID 同样按接收机器人的实现换算，与 adapter-onebot 经 getMessage 取回的引用一致。
          quote: quote && {
            ...quote,
            id: getSatoriMessageId(recipientBot.implementation, quote.id),
            messageId: getSatoriMessageId(recipientBot.implementation, quote.id),
          },
        },
      })
      Object.assign(session, { onebot: payload })
      // v2 按 Session 算会话键，所以跟随放在 Session 构造之后、中间件计时开始之前。
      await followChatConversation(recipientBot.id, context, session)

      const middlewareFinished = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          disposeMiddlewareWait?.()
          disposeMiddlewareWait = undefined
          resolve()
        }, INBOUND_MIDDLEWARE_TIMEOUT_MS)
        disposeMiddlewareWait = onMiddlewareFinished((processedSession) => {
          if (processedSession.id !== session.id) return
          clearTimeout(timer)
          disposeMiddlewareWait?.()
          disposeMiddlewareWait = undefined
          resolve()
        })
      })

      await eventConversations.run(recipientBot.id, context.conversation.id, async () => {
        dispatched = true
        await dispatchEvent(runtimeBot, session)
        await middlewareFinished
      })
    } catch (error) {
      if (!dispatched) recordPreDispatchFailure(recipientBot, payload, startedAt, error)
      throw error
    } finally {
      disposeMiddlewareWait?.()
      disposeMiddlewareWait = undefined
    }
    recordDelivery({
      id: Random.id(),
      recipientBotId: recipientBot.id,
      messageId,
      conversationId: context.conversation.id,
      createdAt: new Date().toISOString(),
    })
  }

  return {
    dispatchEvent,

    async deliverMessage(input) {
      await Promise.all(resolveRecipientBots(input.context).map((recipientBot) => deliverToBot(recipientBot, input)))
    },
  }
}

/** 调试记录里这次派发的动作名：`post_type` 加上它自己那一维的细分类型。 */
function getOneBotEventType(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'unknown'
  const postType = String(Reflect.get(payload, 'post_type') ?? 'unknown')
  const detail = Reflect.get(payload, `${postType}_type`)
  return detail === undefined ? postType : `${postType}.${String(detail)}`
}
