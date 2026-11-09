import { describe, expect, it } from 'vitest'
import type { SandboxMessage } from '../src/types'
import {
  getMessageClusterClass,
  isMergedMessage,
} from '../client/webqq/message-cluster'

function message(id: string, authorId: string, content = id): SandboxMessage {
  return {
    id,
    authorId,
    conversationId: 'private:10001:20001',
    content,
    createdAt: '2026-07-21T00:00:00.000Z',
  }
}

describe('TIM 消息簇', () => {
  it('连续同发送者消息标记首中尾并隐藏后续头像', () => {
    const messages = [message('1', '10001'), message('2', '10001'), message('3', '10001')]

    expect(messages.map((_, index) => getMessageClusterClass(messages, index, '10001')))
      .toEqual(['is-cluster-first', 'is-cluster-middle', 'is-cluster-last'])
    expect(messages.map((_, index) => isMergedMessage(messages, index, '10001')))
      .toEqual([false, true, true])
  })

  it('发送者变化不会合并', () => {
    const messages = [message('1', '10001'), message('2', '20001')]

    expect(getMessageClusterClass(messages, 0, '10001')).toBe('')
    expect(isMergedMessage(messages, 1, '10001')).toBe(false)
    expect(getMessageClusterClass([message('1', '10001'), message('2', '10001')], 0, '10001')).toBe('is-cluster-first')
  })

  describe.each(['10001', '20001'])('发送者 %s 的图片气泡', (authorId) => {
    it.each([
      { name: '文字接图片', kinds: ['text', 'image'], clusters: ['is-cluster-first', 'is-cluster-last'] },
      { name: '图片接文字', kinds: ['image', 'text'], clusters: ['is-cluster-first', 'is-cluster-last'] },
      { name: '两条文字接图片', kinds: ['text', 'text', 'image'], clusters: ['is-cluster-first', 'is-cluster-middle', 'is-cluster-last'] },
      { name: '文字之间的图片', kinds: ['text', 'image', 'text'], clusters: ['is-cluster-first', 'is-cluster-middle', 'is-cluster-last'] },
      { name: '图片之间的文字', kinds: ['image', 'text', 'image'], clusters: ['is-cluster-first', 'is-cluster-middle', 'is-cluster-last'] },
      { name: '两张连续图片', kinds: ['image', 'image'], clusters: ['is-cluster-first', 'is-cluster-last'] },
      { name: '三张连续图片', kinds: ['image', 'image', 'image'], clusters: ['is-cluster-first', 'is-cluster-middle', 'is-cluster-last'] },
    ])('$name 与普通文字气泡使用相同的首中尾圆角', ({ kinds, clusters }) => {
      const messages: SandboxMessage[] = kinds.map((kind, index) => kind === 'image' ? {
        ...message(`image-${index}`, authorId, '[图片] example.png'),
        media: [{ id: `media:${index}`, type: 'image', name: 'example.png', mimeType: 'image/png', size: 1, reference: 'image.bin' }],
      } : message(`text-${index}`, authorId))

      expect(messages.map((_, index) => getMessageClusterClass(messages, index, '10001'))).toEqual(clusters)
      expect(messages.map((_, index) => isMergedMessage(messages, index, '10001'))).toEqual(kinds.map((_, index) => index > 0))
    })
  })

  it('戳一戳事件会中断连续消息合并', () => {
    const event: SandboxMessage = {
      ...message('poke', '10001', '测试用户 戳了戳机器人'),
      event: { type: 'poke', targetId: '20001' },
    }
    const messages = [message('1', '20001'), event, message('2', '20001')]

    expect(messages.map((_, index) => getMessageClusterClass(messages, index, '10001')))
      .toEqual(['', '', ''])
  })

  it('撤回消息继续参与连续消息合并，避免重复头像', () => {
    const recalled: SandboxMessage = {
      ...message('recalled', '20001', '原文仍在'),
      lifecycle: { status: 'recalled', operatorId: '20001', recalledAt: '2026-08-02T00:00:00.000Z' },
    }
    const messages = [message('1', '20001'), recalled, message('2', '20001')]

    expect(messages.map((_, index) => getMessageClusterClass(messages, index, '10001')))
      .toEqual(['is-cluster-first', 'is-cluster-middle', 'is-cluster-last'])
    expect(messages.map((_, index) => isMergedMessage(messages, index, '10001')))
      .toEqual([false, true, true])
  })

  it('同一发送者跨会话的两条消息不合并，分界两侧各自成簇', () => {
    // 分支里继承前缀与自有消息可能是同一个人连着发的两条；合并会让分叉点之后的第一条看起来
    // 是上面那条的续写，连发送者一行都被省掉，分界因此形同不存在。
    const inherited = message('继承', '10001')
    const own = { ...message('自有', '10001'), conversationId: 'branch-1' }
    const messages = [inherited, own]

    expect(isMergedMessage(messages, 1, '10001')).toBe(false)
    expect(messages.map((_, index) => getMessageClusterClass(messages, index, '10001'))).toEqual(['', ''])
  })
})
