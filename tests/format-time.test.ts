import { describe, expect, it } from 'vitest'
import { formatSandboxTimeOfDay } from '../client/shared/format-time'

describe('消息时刻格式化', () => {
  const SHANGHAI = { timeZone: 'Asia/Shanghai', locale: 'zh-CN' } as const

  it('按给定时区解释时刻', () => {
    expect(formatSandboxTimeOfDay('2026-08-29T06:07:00.000Z', SHANGHAI)).toBe('14:07')
    expect(formatSandboxTimeOfDay('2026-08-29T06:07:00.000Z', { timeZone: 'UTC', locale: 'zh-CN' })).toBe('06:07')
  })

  /** 跨日：同一时刻在两个时区分属不同的日历日，时:分必须跟着时区走。 */
  it('跨日边界按目标时区的钟点渲染', () => {
    const instant = '2026-08-29T20:30:00.000Z'
    expect(formatSandboxTimeOfDay(instant, SHANGHAI)).toBe('04:30')
    expect(formatSandboxTimeOfDay(instant, { timeZone: 'UTC', locale: 'zh-CN' })).toBe('20:30')
    expect(formatSandboxTimeOfDay(instant, { timeZone: 'America/Los_Angeles', locale: 'zh-CN' })).toBe('13:30')
  })

  /** 跨年：年界那一刻两个时区一个还在旧年、一个已进新年，钟点同样只由时区决定。 */
  it('跨年边界按目标时区的钟点渲染', () => {
    const newYearEve = '2026-12-31T16:00:00.000Z'
    expect(formatSandboxTimeOfDay(newYearEve, SHANGHAI)).toBe('00:00')
    expect(formatSandboxTimeOfDay(newYearEve, { timeZone: 'UTC', locale: 'zh-CN' })).toBe('16:00')
  })

  it('午夜渲染成 00 点而不是 24 点', () => {
    expect(formatSandboxTimeOfDay('2026-08-29T16:00:00.000Z', SHANGHAI)).toBe('00:00')
    expect(formatSandboxTimeOfDay('2026-08-29T00:00:00.000Z', { timeZone: 'UTC', locale: 'zh-CN' })).toBe('00:00')
    // 十二小时制的语言下午夜是「上午 12:00」，同一时刻不能既是 00 又是 24。
    expect(formatSandboxTimeOfDay('2026-08-29T16:00:00.000Z', { timeZone: 'Asia/Shanghai', locale: 'en-US' }))
      .toBe('12:00 AM')
  })

  /** 非法输入给一个明确的缺省符号；此前渲染成 "Invalid Date"。 */
  it('非法输入给缺省符号', () => {
    expect(formatSandboxTimeOfDay('', SHANGHAI)).toBe('—')
    expect(formatSandboxTimeOfDay('尚未采集', SHANGHAI)).toBe('—')
    expect(formatSandboxTimeOfDay(Number.NaN, SHANGHAI)).toBe('—')
  })

  it('接受时间戳与 Date', () => {
    const instant = '2026-08-29T06:07:00.000Z'
    expect(formatSandboxTimeOfDay(Date.parse(instant), SHANGHAI)).toBe('14:07')
    expect(formatSandboxTimeOfDay(new Date(instant), SHANGHAI)).toBe('14:07')
  })

  /**
   * 不给参数时与浏览器默认行为逐字一致：这正是「时区提成参数」不改变用户所见的依据。
   * 断言对照的是同一份 `Intl` 选项，因此在任何语言与时区的机器上都成立。
   */
  it('不给时区与语言时与环境默认渲染逐字一致', () => {
    const local = new Date(2026, 7, 29, 14, 7, 0)
    expect(formatSandboxTimeOfDay(local))
      .toBe(local.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  })
})
