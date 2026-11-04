import { describe, expect, it } from 'vitest'
import {
  INCOMING_ROW_CLASS,
  computeThinkingPanelFreeze,
  formatThinkingDuration,
  freezeThinkingPanel,
  toggleThinkingExpansion,
  type ThinkingPanelFreezeStyle,
  type ThinkingPanelNode,
  type ThinkingPanelRect,
} from '../client/webqq/thinking-panel'

/** 最小结构接口的内存替身（ADR 0075）：只实现读一个矩形、问一个类名、写七个样式字段。 */
function fakePanel(input: {
  panel: ThinkingPanelRect
  row?: ThinkingPanelRect
  incoming?: boolean
}): ThinkingPanelNode & { style: ThinkingPanelFreezeStyle } {
  const style: ThinkingPanelFreezeStyle = {
    position: '', top: '', left: '', right: '', width: '', maxWidth: '', marginTop: '',
  }
  const row = input.row && {
    getBoundingClientRect: () => input.row!,
    classList: { contains: (token: string) => token === INCOMING_ROW_CLASS && !!input.incoming },
  }
  return {
    parentElement: row ?? null,
    style,
    getBoundingClientRect: () => input.panel,
  }
}

function rect(top: number, left: number, right: number): ThinkingPanelRect {
  return { top, left, right, width: right - left }
}

describe('思考面板', () => {
  describe('时长文案', () => {
    it('没有时长时显示「思考过程」', () => {
      expect(formatThinkingDuration(undefined)).toBe('思考过程')
    })

    it('有时长时按秒取整', () => {
      expect(formatThinkingDuration(0)).toBe('已思考 0s')
      expect(formatThinkingDuration(1499)).toBe('已思考 1s')
      expect(formatThinkingDuration(1500)).toBe('已思考 2s')
      expect(formatThinkingDuration(12_340)).toBe('已思考 12s')
    })

    /** 时长由两个时间戳相减得出，时钟回拨会给出负值；显示「已思考 -3s」不如兜底到 0。 */
    it('负值兜底到 0', () => {
      expect(formatThinkingDuration(-1)).toBe('已思考 0s')
      expect(formatThinkingDuration(-99_999)).toBe('已思考 0s')
    })
  })

  describe('展开态', () => {
    it('第一次点开、再点收起', () => {
      const opened = toggleThinkingExpansion({}, 'm1')
      expect(opened).toEqual({ m1: true })
      expect(toggleThinkingExpansion(opened, 'm1')).toEqual({})
    })

    it('多条消息各自独立展开', () => {
      const both = toggleThinkingExpansion(toggleThinkingExpansion({}, 'm1'), 'm2')
      expect(both).toEqual({ m1: true, m2: true })
      expect(toggleThinkingExpansion(both, 'm1')).toEqual({ m2: true })
    })

    /** 就地改不会触发重渲染，表现为点了没反应；因此必须返回新对象。 */
    it('返回新对象，不就地修改入参', () => {
      const before = { m1: true } as const
      const after = toggleThinkingExpansion(before, 'm2')
      expect(after).not.toBe(before)
      expect(before).toEqual({ m1: true })
    })
  })

  describe('离场冻结', () => {
    it('脱流并按行内相对位置钉住顶缘', () => {
      const style = computeThinkingPanelFreeze({
        panel: rect(140, 200, 500),
        row: rect(100, 180, 900),
        incoming: true,
      })

      expect(style.position).toBe('absolute')
      expect(style.top).toBe('40px')
      expect(style.width).toBe('300px')
      expect(style.marginTop).toBe('0')
    })

    /**
     * 面板脱流后思考行的宽度立刻收缩成指标行宽度：入向行左缘不变、出向行右缘不变。
     * 钉错一侧面板会在离场瞬间水平跳位，而且不会报错。两个方向都要断言——只测一个方向的话，
     * 把判定写成常量也不会红。
     */
    it('入向行钉左缘，出向行钉右缘', () => {
      const incoming = computeThinkingPanelFreeze({
        panel: rect(140, 200, 500),
        row: rect(100, 180, 900),
        incoming: true,
      })
      expect(incoming.left).toBe('20px')
      expect(incoming.right).toBe('')

      const outgoing = computeThinkingPanelFreeze({
        panel: rect(140, 200, 500),
        row: rect(100, 180, 900),
        incoming: false,
      })
      expect(outgoing.right).toBe('400px')
      expect(outgoing.left).toBe('')
    })

    /**
     * `max-width: min(360px, 100%)` 里的 `100%` 同样按收缩后的行宽重算，会把冻结宽度压小，
     * 迫使单行思考内容先换行再淡出。
     */
    it('解除宽度百分比约束', () => {
      const style = computeThinkingPanelFreeze({ panel: rect(0, 0, 300), row: rect(0, 0, 900), incoming: true })
      expect(style.maxWidth).toBe('none')
    })

    it('把算出的样式写回面板', () => {
      const panel = fakePanel({ panel: rect(140, 200, 500), row: rect(100, 180, 900), incoming: true })
      const style = freezeThinkingPanel(panel)

      expect(style).toBeDefined()
      expect(panel.style.position).toBe('absolute')
      expect(panel.style.top).toBe('40px')
      expect(panel.style.left).toBe('20px')
      expect(panel.style.width).toBe('300px')
      expect(panel.style.maxWidth).toBe('none')
    })

    /** 节点已经脱离文档树时读到的矩形全是零，写回去会把面板钉到视口左上角。 */
    it('没有父行时什么都不写', () => {
      const panel = fakePanel({ panel: rect(0, 0, 0) })

      expect(freezeThinkingPanel(panel)).toBeUndefined()
      expect(panel.style.position).toBe('')
    })
  })
})
