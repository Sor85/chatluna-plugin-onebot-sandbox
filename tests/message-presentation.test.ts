import { describe, expect, it } from 'vitest'
import {
  formatMediaSize,
  getEventMessageText,
  getForwardPreview,
  getMediaLabel,
  getMessageText,
  getMessageThinking,
  getMessageUsage,
  getReplyMessage,
  isForkBoundary,
  isInheritedMessage,
  readMessageCapabilities,
  resolveForwardOpenInput,
  resolveReactionToggle,
  shouldRenderAsEvent,
  shouldShowThinking,
  shouldShowUsage,
  type MessagePresentationContext,
} from '../client/webqq/message-presentation'
import { NO_MESSAGE_CAPABILITIES, type MessageCapabilities } from '../src/message-capabilities'
import type { SandboxMessage } from '../src/types'

const CONVERSATION = 'private:10001:20001'

function image(id: string, name: string, size = 1024) {
  return { id, type: 'image' as const, name, size, mimeType: 'image/png', reference: `media:${id}` }
}

const BRANCH = 'branch-1'

function message(overrides: Partial<SandboxMessage> = {}): SandboxMessage {
  return {
    id: 'm1',
    authorId: '10001',
    conversationId: CONVERSATION,
    content: '你好',
    createdAt: '2026-08-30T09:00:00.000Z',
    ...overrides,
  } as SandboxMessage
}

function recalled(overrides: Partial<SandboxMessage> = {}): SandboxMessage {
  return message({
    ...overrides,
    lifecycle: { status: 'recalled', operatorId: '20001', recalledAt: '2026-08-30T09:01:00.000Z' },
  })
}

function context(overrides: Partial<MessagePresentationContext> = {}): MessagePresentationContext {
  return {
    replyMessages: {},
    forwardPreviews: {},
    messageCapabilities: {},
    participantNames: {},
    markRecalledMessages: true,
    currentConversationId: CONVERSATION,
    currentOperatorId: '10001',
    ...overrides,
  }
}

function capabilities(overrides: Partial<MessageCapabilities> = {}): MessageCapabilities {
  return { ...NO_MESSAGE_CAPABILITIES, ...overrides }
}

describe('消息呈现判定', () => {
  describe('事件化', () => {
    it('事件消息永远渲染成事件行', () => {
      const poke = message({ event: { type: 'poke', targetId: '20001' } })

      expect(shouldRenderAsEvent(poke, context({ markRecalledMessages: true }))).toBe(true)
      expect(shouldRenderAsEvent(poke, context({ markRecalledMessages: false }))).toBe(true)
    })

    /** 撤回标记的两个方向都要断言：只测一个方向的话，把判定改成常量也不会红。 */
    it('撤回消息只在关闭撤回标记时事件化', () => {
      expect(shouldRenderAsEvent(recalled(), context({ markRecalledMessages: false }))).toBe(true)
      expect(shouldRenderAsEvent(recalled(), context({ markRecalledMessages: true }))).toBe(false)
    })

    it('普通消息不事件化', () => {
      expect(shouldRenderAsEvent(message(), context({ markRecalledMessages: false }))).toBe(false)
    })

    it('撤回事件行按操作者渲染文案，其余事件行用消息正文', () => {
      expect(getEventMessageText(recalled(), (id) => `昵称${id}`)).toBe('昵称20001 撤回了一条消息')
      expect(getEventMessageText(message({ content: '戳了戳你' }), () => '不会用到')).toBe('戳了戳你')
    })

    /** 撤回者可能不是作者：管理员撤回别人的消息时文案要写管理员。 */
    it('撤回事件的操作者优先取生命周期里的撤回者', () => {
      const names: Record<string, string> = { '20001': '管理员', '10001': '作者' }
      expect(getEventMessageText(recalled(), (id) => names[id]!)).toBe('管理员 撤回了一条消息')
    })
  })

  describe('思考与用量随撤回标记一同隐藏', () => {
    const thinking = message({ chatLuna: { thought: '想了想' } })
    const usageOnly = message({
      chatLuna: { thought: '', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
    })

    it('有思考内容时取到思考，只有用量时取到用量，两者互斥', () => {
      expect(getMessageThinking(thinking)).toBeDefined()
      expect(getMessageUsage(thinking)).toBeUndefined()
      expect(getMessageThinking(usageOnly)).toBeUndefined()
      expect(getMessageUsage(usageOnly)).toBeDefined()
      expect(getMessageThinking(message())).toBeUndefined()
      expect(getMessageUsage(message())).toBeUndefined()
    })

    it('关闭撤回标记时撤回消息的思考与用量一并隐藏', () => {
      const recalledThinking = recalled({ chatLuna: { thought: '想了想' } })
      const recalledUsage = recalled({
        chatLuna: { thought: '', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
      })

      expect(shouldShowThinking(recalledThinking, context({ markRecalledMessages: false }))).toBe(false)
      expect(shouldShowUsage(recalledUsage, context({ markRecalledMessages: false }))).toBe(false)
    })

    it('开启撤回标记时撤回消息的思考与用量仍可读', () => {
      const recalledThinking = recalled({ chatLuna: { thought: '想了想' } })

      expect(shouldShowThinking(recalledThinking, context({ markRecalledMessages: true }))).toBe(true)
      expect(shouldShowThinking(thinking, context())).toBe(true)
      expect(shouldShowUsage(usageOnly, context())).toBe(true)
    })
  })

  describe('正文取值', () => {
    it('合并转发卡片的正文返回空串，不与预览行重复', () => {
      expect(getMessageText(message({ forwardId: 'f1', content: '[合并转发]' }), context())).toBe('')
    })

    it('单媒体且正文恰为「标签加文件名」时去重', () => {
      const media = [image('a1', '猫.png')]
      expect(getMessageText(message({ media, content: '[图片] 猫.png' }), context())).toBe('')
    })

    it('正文与生成摘要不同时保留正文', () => {
      const media = [image('a1', '猫.png')]
      expect(getMessageText(message({ media, content: '看这只猫' }), context())).toBe('看这只猫')
    })

    /** 去重只对单媒体成立：多媒体时正文是所有条目的拼接，删掉会丢信息。 */
    it('多媒体消息不去重', () => {
      const media = [image('a1', '猫.png'), image('a2', '狗.png', 2048)]
      expect(getMessageText(message({ media, content: '[图片] 猫.png' }), context())).toBe('[图片] 猫.png')
    })

    it('正文里的提及按参与者名字展开', () => {
      const withMention = message({ content: '<at id="20001" /> 在吗' })
      const text = getMessageText(withMention, context({ participantNames: { '20001': '小明' } }))
      expect(text).toBe('@小明 在吗')
    })
  })

  describe('引用消息与转发预览查表', () => {
    const quoted = message({ id: 'q1', content: '被引用的' })

    it('按引用标识查表', () => {
      const withReply = message({ replyToMessageId: 'q1' })
      expect(getReplyMessage(withReply, context({ replyMessages: { q1: quoted } }))?.id).toBe('q1')
    })

    it('没有引用标识，或表里查不到时都当没有引用', () => {
      expect(getReplyMessage(message(), context({ replyMessages: { q1: quoted } }))).toBeUndefined()
      expect(getReplyMessage(message({ replyToMessageId: 'q1' }), context())).toBeUndefined()
    })

    const preview = { title: '群聊的聊天记录', total: 3, lines: ['甲：一'] }

    it('按消息标识查转发预览', () => {
      const forwarded = message({ forwardId: 'f1' })
      expect(getForwardPreview(forwarded, context({ forwardPreviews: { m1: preview } }))).toEqual(preview)
    })

    /**
     * 先看消息自己有没有转发标识再查表：只查表会让「预览表里恰好有同名条目」的普通消息
     * 误显示成转发卡片。
     */
    it('没有转发标识的消息即使预览表里有同名条目也不算转发', () => {
      expect(getForwardPreview(message(), context({ forwardPreviews: { m1: preview } }))).toBeUndefined()
    })

    it('预览未就绪时打开转发这一下没有反应', () => {
      const forwarded = message({ forwardId: 'f1' })
      expect(resolveForwardOpenInput(forwarded, context())).toBeUndefined()
      expect(resolveForwardOpenInput(message(), context({ forwardPreviews: { m1: preview } }))).toBeUndefined()
      expect(resolveForwardOpenInput(forwarded, context({ forwardPreviews: { m1: preview } })))
        .toEqual({ messageId: 'm1', forwardId: 'f1' })
    })
  })

  describe('消息能力位读取', () => {
    it('读投影给出的能力位', () => {
      const caps = capabilities({ recall: true, reply: true })
      expect(readMessageCapabilities(message(), context({ messageCapabilities: { m1: caps } }))).toEqual(caps)
    })

    /** 投影还没给出这条消息时读作「一条都做不到」，不猜——猜会让右键里出现做不到的动作。 */
    it('投影里没有这条消息时一条都做不到', () => {
      expect(readMessageCapabilities(message(), context())).toEqual(NO_MESSAGE_CAPABILITIES)
    })
  })

  describe('继承前缀归属与分叉点分界', () => {
    const inherited = message({ id: '继承', conversationId: CONVERSATION })
    const own = message({ id: '自有', conversationId: BRANCH })

    it('归属会话与当前会话不同的是继承前缀', () => {
      expect(isInheritedMessage(inherited, context({ currentConversationId: BRANCH }))).toBe(true)
      expect(isInheritedMessage(own, context({ currentConversationId: BRANCH }))).toBe(false)
    })

    it('分界画在继承前缀之后的第一条自有消息上', () => {
      const messages = [inherited, message({ id: '继承二' }), own, message({ id: '自有二', conversationId: BRANCH })]
      const flags = messages.map((_, index) => isForkBoundary(messages, index, context({ currentConversationId: BRANCH })))

      expect(flags).toEqual([false, false, true, false])
    })

    it('根会话不画分界', () => {
      const messages = [inherited, message({ id: '第二条' })]
      const flags = messages.map((_, index) => isForkBoundary(messages, index, context()))

      expect(flags).toEqual([false, false])
    })
  })

  describe('媒体标签与媒体大小', () => {
    it('四种媒体类型各有标签', () => {
      expect(getMediaLabel({ type: 'image' })).toBe('图片')
      expect(getMediaLabel({ type: 'audio' })).toBe('语音')
      expect(getMediaLabel({ type: 'video' })).toBe('视频')
      expect(getMediaLabel({ type: 'file' })).toBe('文件')
    })

    it('体积按 1024 进制换算，KB 与 MB 保留一位小数', () => {
      expect(formatMediaSize(0)).toBe('0 B')
      expect(formatMediaSize(1023)).toBe('1023 B')
      expect(formatMediaSize(1024)).toBe('1.0 KB')
      expect(formatMediaSize(1536)).toBe('1.5 KB')
      expect(formatMediaSize(1024 * 1024 - 1)).toBe('1024.0 KB')
      expect(formatMediaSize(1024 * 1024)).toBe('1.0 MB')
      expect(formatMediaSize(3 * 1024 * 1024 + 512 * 1024)).toBe('3.5 MB')
    })
  })

  describe('表情回应的双闸门', () => {
    const reactive = context({
      messageCapabilities: { m1: capabilities({ react: true }) },
      currentOperatorId: '10001',
    })

    it('能力位与操作者都具备时才生效', () => {
      expect(resolveReactionToggle(message(), '128077', reactive))
        .toEqual({ messageId: 'm1', emojiId: '128077', enabled: true })
    })

    it('能力位不允许时这一下没有反应', () => {
      expect(resolveReactionToggle(message(), '128077', context({ currentOperatorId: '10001' })))
        .toBeUndefined()
    })

    /** 少这道闸门会贴出一条无主回应。 */
    it('没有当前操作者时这一下没有反应', () => {
      expect(resolveReactionToggle(message(), '128077', context({
        messageCapabilities: { m1: capabilities({ react: true }) },
        currentOperatorId: undefined,
      }))).toBeUndefined()
    })

    it('当前操作者已经贴过时改为取消', () => {
      const reacted = message({ reactions: [{ emojiId: '128077', participantIds: ['10001', '20001'] }] })
      expect(resolveReactionToggle(reacted, '128077', reactive)?.enabled).toBe(false)
    })

    it('别人贴过但自己没贴时仍是贴上', () => {
      const reacted = message({ reactions: [{ emojiId: '128077', participantIds: ['20001'] }] })
      expect(resolveReactionToggle(reacted, '128077', reactive)?.enabled).toBe(true)
    })
  })
})
