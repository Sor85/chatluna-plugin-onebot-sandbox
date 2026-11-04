import { describe, expect, it } from 'vitest'
import type { SandboxMessage } from '../src/types'
import { isInheritedMessage } from '../src/conversation-resolution'
import { isForkBoundaryMessage } from '../client/webqq/fork-boundary'

const ROOT = 'private:10001:20001'
const BRANCH = 'branch-1'

function message(id: string, conversationId: string): SandboxMessage {
  return {
    id,
    authorId: '10001',
    conversationId,
    content: id,
    createdAt: '2026-08-30T00:00:00.000Z',
  }
}

describe('分支视图的分界标记', () => {
  it('分界画在继承前缀之后的第一条自有消息上', () => {
    const messages = [
      message('继承一', ROOT),
      message('继承二', ROOT),
      message('自有一', BRANCH),
      message('自有二', BRANCH),
    ]

    expect(messages.map((_, index) => isForkBoundaryMessage(messages, index, BRANCH)))
      .toEqual([false, false, true, false])
    // 继承部分整段可辨认，不只有边界那一条：视觉弱化要覆盖对照区全部消息。
    expect(messages.map((message) => isInheritedMessage(message, BRANCH)))
      .toEqual([true, true, false, false])
  })

  it('根会话与没有继承前缀的实例都不画分界', () => {
    const rootMessages = [message('一', ROOT), message('二', ROOT)]
    expect(rootMessages.map((_, index) => isForkBoundaryMessage(rootMessages, index, ROOT))).toEqual([false, false])
    expect(rootMessages.map((message) => isInheritedMessage(message, ROOT))).toEqual([false, false])

    // 空白实例与场景里已有的复制型旧分支形状相同：只有自有消息。
    const ownOnly = [message('自有一', BRANCH), message('自有二', BRANCH)]
    expect(ownOnly.map((_, index) => isForkBoundaryMessage(ownOnly, index, BRANCH))).toEqual([false, false])
  })

  it('刚创建、还没有自有消息的分支只有继承前缀，因此还没有分界', () => {
    const messages = [message('继承一', ROOT), message('继承二', ROOT)]

    expect(messages.map((_, index) => isForkBoundaryMessage(messages, index, BRANCH))).toEqual([false, false])
    expect(messages.every((message) => isInheritedMessage(message, BRANCH))).toBe(true)
  })

  it('从分支里再分叉时前缀跨两段，分界仍然只有一条', () => {
    // 来源链上每条消息带的是自己那一段的会话 ID，都不等于当前会话，因此整段前缀一致弱化。
    const messages = [
      message('根会话那条', ROOT),
      message('上一条分支里的提问', BRANCH),
      message('本分支自有', 'branch-2'),
    ]

    expect(messages.map((_, index) => isForkBoundaryMessage(messages, index, 'branch-2')))
      .toEqual([false, false, true])
    expect(messages.map((message) => isInheritedMessage(message, 'branch-2')))
      .toEqual([true, true, false])
  })

  it('当前会话未知时不弱化任何一条，也不画分界', () => {
    const messages = [message('一', ROOT), message('二', BRANCH)]

    expect(messages.map((message) => isInheritedMessage(message, undefined))).toEqual([false, false])
    expect(messages.map((_, index) => isForkBoundaryMessage(messages, index, undefined))).toEqual([false, false])
  })
})
