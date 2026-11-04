import { describe, expect, it } from 'vitest'
import {
  MESSAGE_BUBBLE_SELECTOR,
  readPointerContext,
  routeAvatarClick,
  routeBubbleClick,
  routeRowClick,
  type MessagePointerContext,
} from '../client/webqq/message-pointer-routing'
import { NO_MESSAGE_CAPABILITIES } from '../src/message-capabilities'

function context(overrides: Partial<MessagePointerContext> = {}): MessagePointerContext {
  return { selectionMode: false, forwardCapability: true, ...overrides }
}

/** 最小结构接口的替身：只实现 `closest`，返回值只看真假。 */
function target(matches: readonly string[]): { closest(selector: string): unknown } {
  return { closest: (selector) => (matches.includes(selector) ? {} : null) }
}

describe('消息指针交互分流', () => {
  describe('点头像', () => {
    it('非多选态打开资料卡', () => {
      expect(routeAvatarClick(context())).toEqual({ kind: 'open-profile' })
    })

    /**
     * 多选态下头像仍属于整条消息的可选区域，因此这里返回 `none` 让事件继续冒泡到整条。
     * 改成阻断冒泡的表现是「多选下点头像没反应」，一条断言都不会红。
     */
    it('多选态什么都不做，把事件交给整条', () => {
      expect(routeAvatarClick(context({ selectionMode: true }))).toEqual({ kind: 'none' })
    })

    /** 头像不是消息动作入口，能不能转发与它无关。 */
    it('多选态下即使这条不能转发，头像仍不阻断冒泡', () => {
      expect(routeAvatarClick(context({ selectionMode: true, forwardCapability: false }))).toEqual({ kind: 'none' })
    })
  })

  describe('点气泡（捕获阶段）', () => {
    it('多选且这条能转发时接管，改为切换勾选', () => {
      expect(routeBubbleClick(context({ selectionMode: true }))).toEqual({ kind: 'toggle-selection' })
    })

    /** 四种组合逐个成立：少测一个就无法区分「两个条件都看」和「只看其中一个」。 */
    it('其余三种组合都不接管', () => {
      expect(routeBubbleClick(context({ selectionMode: false, forwardCapability: true }))).toEqual({ kind: 'none' })
      expect(routeBubbleClick(context({ selectionMode: false, forwardCapability: false }))).toEqual({ kind: 'none' })
      expect(routeBubbleClick(context({ selectionMode: true, forwardCapability: false }))).toEqual({ kind: 'none' })
    })
  })

  describe('点整条', () => {
    it('多选且能转发，且落点不在气泡里时切换勾选', () => {
      expect(routeRowClick(context({ selectionMode: true }), target([]))).toEqual({ kind: 'toggle-selection' })
    })

    /**
     * 气泡由捕获处理器统一接管；不排除气泡区会让同一次点击被切换两次，
     * 净效果是勾选状态不变——看起来像「点了没反应」。
     */
    it('落点在气泡里时不处理', () => {
      expect(routeRowClick(context({ selectionMode: true }), target([MESSAGE_BUBBLE_SELECTOR])))
        .toEqual({ kind: 'none' })
    })

    it('非多选态或这条不能转发时不处理', () => {
      expect(routeRowClick(context(), target([]))).toEqual({ kind: 'none' })
      expect(routeRowClick(context({ selectionMode: true, forwardCapability: false }), target([])))
        .toEqual({ kind: 'none' })
    })

    it('没有落点时按不在气泡里处理', () => {
      expect(routeRowClick(context({ selectionMode: true }), null)).toEqual({ kind: 'toggle-selection' })
    })
  })

  describe('分流上下文', () => {
    it('从多选态与能力位读出两个输入', () => {
      expect(readPointerContext(undefined, NO_MESSAGE_CAPABILITIES))
        .toEqual({ selectionMode: false, forwardCapability: false })
      expect(readPointerContext(true, { ...NO_MESSAGE_CAPABILITIES, forward: true }))
        .toEqual({ selectionMode: true, forwardCapability: true })
    })
  })
})
