import { describe, expect, it } from 'vitest'
import { formatThinkingDuration } from '../client/webqq/thinking-panel'

const t = (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key

describe('思考面板时长文案', () => {
  it('没有时长时显示「思考过程」', () => {
    expect(formatThinkingDuration(t, undefined)).toBe('sandbox.chat.thinkingProcess')
  })

  it('有时长时按秒取整', () => {
    expect(formatThinkingDuration(t, 0)).toBe('sandbox.chat.thoughtFor:{"seconds":0}')
    expect(formatThinkingDuration(t, 1499)).toBe('sandbox.chat.thoughtFor:{"seconds":1}')
    expect(formatThinkingDuration(t, 1500)).toBe('sandbox.chat.thoughtFor:{"seconds":2}')
    expect(formatThinkingDuration(t, 12_340)).toBe('sandbox.chat.thoughtFor:{"seconds":12}')
  })

  /** 时长由两个时间戳相减得出，时钟回拨会给出负值；显示「已思考 -3s」不如兜底到 0。 */
  it('负值兜底到 0', () => {
    expect(formatThinkingDuration(t, -1)).toBe('sandbox.chat.thoughtFor:{"seconds":0}')
    expect(formatThinkingDuration(t, -99_999)).toBe('sandbox.chat.thoughtFor:{"seconds":0}')
  })
})
