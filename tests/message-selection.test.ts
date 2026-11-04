import { describe, expect, it } from 'vitest'
import {
  NO_MESSAGE_SELECTION,
  hasSelectedMessages,
  enterMessageSelection,
  exitMessageSelection,
  readForwardCapability,
  resolveForwardConfirmation,
  routeEscapeKey,
  toggleMessageSelection,
  type EscapeContext,
  type MessageSelectionContext,
} from '../client/webqq/message-selection'
import { NO_MESSAGE_CAPABILITIES } from '../src/message-capabilities'

/** 三条可转发、一条不可转发（事件行或已撤回都落在这一位上）。 */
function context(forwardable: readonly string[] = ['m1', 'm2', 'm3']): MessageSelectionContext {
  return {
    messageCapabilities: Object.fromEntries([
      ...forwardable.map((id) => [id, { ...NO_MESSAGE_CAPABILITIES, forward: true }]),
      ['blocked', NO_MESSAGE_CAPABILITIES],
    ]),
  }
}

function escape(overrides: Partial<EscapeContext> = {}): EscapeContext {
  return {
    selectionActive: false,
    forwardTargetOpen: false,
    searchOpen: false,
    searchDatePopoverOpen: false,
    ...overrides,
  }
}

describe('消息多选与合并转发', () => {
  describe('可选性读能力位', () => {
    it('读投影给出的 forward 位', () => {
      expect(readForwardCapability('m1', context())).toBe(true)
      expect(readForwardCapability('blocked', context())).toBe(false)
    })

    /** 投影还没给出这条消息时读作不能：宁可少给一个动作，也不要提供服务端会拒绝的动作。 */
    it('投影里没有这条消息时读作不能转发', () => {
      expect(readForwardCapability('缺席', context())).toBe(false)
    })
  })

  describe('进入多选', () => {
    it('入口那条成为默认选中', () => {
      expect(enterMessageSelection('m2', context())).toEqual({ active: true, messageIds: ['m2'] })
    })

    /** 不可转发的消息进入后会得到「已选 0 条」的空多选态，因此干脆不进。 */
    it('不可转发的消息不能作为入口', () => {
      expect(enterMessageSelection('blocked', context())).toBeUndefined()
      expect(enterMessageSelection('缺席', context())).toBeUndefined()
    })

    it('重复进入按新入口重置选中，不累加', () => {
      const first = enterMessageSelection('m1', context())!
      expect(enterMessageSelection('m3', context())).toEqual({ active: true, messageIds: ['m3'] })
      expect(first.messageIds).toEqual(['m1'])
    })
  })

  describe('切换选中', () => {
    const active = { active: true, messageIds: ['m1'] }

    it('未选中的加进来，已选中的去掉', () => {
      const both = toggleMessageSelection(active, 'm2', context())
      expect(both.messageIds).toEqual(['m1', 'm2'])
      expect(toggleMessageSelection(both, 'm1', context()).messageIds).toEqual(['m2'])
    })

    it('取消最后一条后仍在多选态，只是选中为空', () => {
      const empty = toggleMessageSelection(active, 'm1', context())
      expect(empty).toEqual({ active: true, messageIds: [] })
    })

    /** 列表在非多选态下不派发这个动作，但外壳与页面能派发；少这道闸门会悄悄改掉选中集合。 */
    it('不在多选态时什么都不做', () => {
      expect(toggleMessageSelection(NO_MESSAGE_SELECTION, 'm1', context())).toBe(NO_MESSAGE_SELECTION)
    })

    it('不可转发的消息不能被勾选', () => {
      expect(toggleMessageSelection(active, 'blocked', context())).toBe(active)
    })
  })

  describe('退出多选', () => {
    it('退出后既不在多选态也没有选中', () => {
      expect(exitMessageSelection()).toEqual({ active: false, messageIds: [] })
    })

    it('空选中退出同样干净', () => {
      expect(exitMessageSelection()).toEqual(NO_MESSAGE_SELECTION)
    })
  })

  describe('目标会话对话框', () => {
    it('有选中才允许打开', () => {
      expect(hasSelectedMessages({ active: true, messageIds: ['m1'] })).toBe(true)
      expect(hasSelectedMessages({ active: true, messageIds: [] })).toBe(false)
    })
  })

  describe('确认转发', () => {
    it('成功路径给出目标会话与消息集合', () => {
      expect(resolveForwardConfirmation({ active: true, messageIds: ['m1', 'm2'] }, 'private:1:2', context()))
        .toEqual({ kind: 'send', conversationId: 'private:1:2', messageIds: ['m1', 'm2'] })
    })

    /**
     * 从进入多选到点确认之间，选中的消息可能已经被撤回。确认那一刻重新过滤一遍，
     * 否则整批会被服务端拒掉。
     */
    it('确认那一刻重新过滤，已经不可转发的被剔掉', () => {
      const result = resolveForwardConfirmation(
        { active: true, messageIds: ['m1', 'blocked', 'm2'] },
        'private:1:2',
        context(),
      )
      expect(result).toEqual({ kind: 'send', conversationId: 'private:1:2', messageIds: ['m1', 'm2'] })
    })

    it('过滤后为空时本地就拒绝，不发无谓的 RPC', () => {
      expect(resolveForwardConfirmation({ active: true, messageIds: ['blocked'] }, 'private:1:2', context()))
        .toEqual({ kind: 'reject', message: '请先选择可转发的消息' })
      expect(resolveForwardConfirmation({ active: true, messageIds: [] }, 'private:1:2', context()))
        .toEqual({ kind: 'reject', message: '请先选择可转发的消息' })
    })
  })

  describe('Escape 的优先级', () => {
    /**
     * 顺序是判定而不是巧合：多选态下开着目标对话框时按 Escape 只该退回多选，
     * 连多选一起退掉会让用户选好的一批消息白选。
     */
    it('目标会话对话框开着时先关它，多选态保留', () => {
      expect(routeEscapeKey(escape({ selectionActive: true, forwardTargetOpen: true })))
        .toEqual({ kind: 'close-forward-target' })
    })

    it('多选态下没开对话框时退出多选', () => {
      expect(routeEscapeKey(escape({ selectionActive: true }))).toEqual({ kind: 'exit-selection' })
    })

    it('多选优先于搜索', () => {
      expect(routeEscapeKey(escape({ selectionActive: true, searchOpen: true })))
        .toEqual({ kind: 'exit-selection' })
    })

    it('只开着搜索时关闭搜索', () => {
      expect(routeEscapeKey(escape({ searchOpen: true }))).toEqual({ kind: 'close-search' })
    })

    /** 日期弹层自己会吃掉 Escape；此时连搜索一起关会让用户少按一次就丢掉搜索条件。 */
    it('日期弹层开着时不关搜索', () => {
      expect(routeEscapeKey(escape({ searchOpen: true, searchDatePopoverOpen: true })))
        .toEqual({ kind: 'none' })
    })

    it('什么都没开时不处理', () => {
      expect(routeEscapeKey(escape())).toEqual({ kind: 'none' })
    })
  })
})
