import { describe, expect, it } from 'vitest'
import {
  buildMessageListTail,
  getMessageListDistanceFromBottom,
  isMessageListNearBottom,
  MESSAGE_LIST_BOTTOM_THRESHOLD,
  scrollMessageListToBottom,
  shouldFollowMessageListTail,
} from '../client/webqq/message-list-scroll'

describe('WebQQ 消息列表置底追踪', () => {
  it('按底部距离和阈值判断是否继续追踪', () => {
    expect(getMessageListDistanceFromBottom({ scrollTop: 760, scrollHeight: 1000, clientHeight: 240 })).toBe(0)
    expect(isMessageListNearBottom({ scrollTop: 736, scrollHeight: 1000, clientHeight: 240 })).toBe(true)
    expect(isMessageListNearBottom({ scrollTop: 735, scrollHeight: 1000, clientHeight: 240 })).toBe(false)
    expect(isMessageListNearBottom({ scrollTop: 0, scrollHeight: 180, clientHeight: 240 })).toBe(true)
    expect(MESSAGE_LIST_BOTTOM_THRESHOLD).toBe(24)
  })

  it('尾部签名只跟踪末条消息和当前会话的 thinking 状态', () => {
    const tail = buildMessageListTail({
      conversationId: 'private:1:2',
      messages: [{ id: 'old' }, { id: 'latest' }],
      chatLunaStates: [
        { botParticipantId: 'bot-b', conversationId: 'private:1:2', thinking: true },
        { botParticipantId: 'bot-a', conversationId: 'private:1:2', thinking: true },
        { botParticipantId: 'bot-c', conversationId: 'private:other', thinking: true },
        { botParticipantId: 'bot-d', conversationId: 'private:1:2', thinking: false },
      ],
    })

    expect(tail).toEqual({
      conversationId: 'private:1:2',
      lastMessageId: 'latest',
      thinkingIds: ['bot-a:private:1:2', 'bot-b:private:1:2'],
    })
  })

  it('仅在置底且尾部变化时追踪，同会话历史前插不触发', () => {
    const previous = buildMessageListTail({
      conversationId: 'private:1:2',
      messages: [{ id: 'first' }, { id: 'latest' }],
      chatLunaStates: [],
    })
    const prepended = buildMessageListTail({
      conversationId: 'private:1:2',
      messages: [{ id: 'older' }, { id: 'first' }, { id: 'latest' }],
      chatLunaStates: [],
    })
    const appended = buildMessageListTail({
      conversationId: 'private:1:2',
      messages: [{ id: 'first' }, { id: 'latest' }, { id: 'new' }],
      chatLunaStates: [],
    })
    const thinking = buildMessageListTail({
      conversationId: 'private:1:2',
      messages: [{ id: 'first' }, { id: 'latest' }],
      chatLunaStates: [{ botParticipantId: 'bot', conversationId: 'private:1:2', thinking: true }],
    })

    expect(shouldFollowMessageListTail(previous, prepended, true)).toBe(false)
    expect(shouldFollowMessageListTail(previous, appended, true)).toBe(true)
    expect(shouldFollowMessageListTail(previous, thinking, true)).toBe(true)
    expect(shouldFollowMessageListTail(previous, appended, false)).toBe(false)
  })

  it('首次渲染和切换会话交给滚动状态键处理', () => {
    const first = buildMessageListTail({ conversationId: 'private:1:2', messages: [], chatLunaStates: [] })
    const next = buildMessageListTail({ conversationId: 'private:1:3', messages: [], chatLunaStates: [] })

    expect(shouldFollowMessageListTail(undefined, first, false)).toBe(false)
    expect(shouldFollowMessageListTail(first, next, false)).toBe(false)
  })

  it('直接把滚动容器移动到内容末尾', () => {
    const element = { scrollTop: 120, scrollHeight: 900, clientHeight: 300 }

    scrollMessageListToBottom(element)

    expect(element.scrollTop).toBe(900)
  })
})
