import { describe, expect, it } from 'vitest'
import {
  buildMessageListScrollStateKey,
  calculateAnchoredMessageListScrollTop,
  readMessageListScrollState,
  writeMessageListScrollState,
} from '../client/webqq/message-list-scroll-state'

describe('消息列表滚动状态', () => {
  it('按空间与会话隔离滚动位置', () => {
    const mainKey = buildMessageListScrollStateKey(undefined, 'conversation:1')
    const spaceKey = buildMessageListScrollStateKey('space:1', 'conversation:1')

    writeMessageListScrollState(mainKey, {
      scrollTop: 320,
      stickingToBottom: false,
      anchor: { messageId: 'message:1', offsetTop: -18 },
    })
    writeMessageListScrollState(spaceKey, { scrollTop: 0, stickingToBottom: true })

    expect(mainKey).not.toBe(spaceKey)
    expect(readMessageListScrollState(mainKey)).toEqual({
      scrollTop: 320,
      stickingToBottom: false,
      anchor: { messageId: 'message:1', offsetTop: -18 },
    })
    expect(readMessageListScrollState(spaceKey)).toEqual({ scrollTop: 0, stickingToBottom: true })
  })

  it('按锚点相对位置抵消锚点前方的布局高度变化', () => {
    expect(calculateAnchoredMessageListScrollTop({
      currentScrollTop: 260,
      currentAnchorTop: 340,
      containerTop: 100,
      savedAnchorOffsetTop: -20,
    })).toBe(520)
  })

  it('没有会话时不创建缓存键', () => {
    expect(buildMessageListScrollStateKey('space:1', undefined)).toBeUndefined()
  })
})
