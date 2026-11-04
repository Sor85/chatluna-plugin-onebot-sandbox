import { describe, expect, it } from 'vitest'
import {
  calendarValueToLocalDate,
  localDateToCalendarValue,
  localDateToMessageSearchRange,
} from '../client/webqq/message-search-date'

describe('聊天记录搜索日期', () => {
  it('把本地自然日转换为本地零点到次日零点的 ISO 半开区间', () => {
    const range = localDateToMessageSearchRange('2026-08-10')
    expect(range).toBeDefined()

    const expectedStart = new Date(2026, 7, 10)
    const expectedEnd = new Date(2026, 7, 10)
    expectedEnd.setDate(expectedEnd.getDate() + 1)
    expect(range).toEqual({
      createdAtStart: expectedStart.toISOString(),
      createdAtEnd: expectedEnd.toISOString(),
    })
  })

  it('在日历控件的本地零点 Date 与搜索字符串之间无损转换', () => {
    const calendarValue = localDateToCalendarValue('2026-08-10')
    expect([calendarValue?.getFullYear(), calendarValue?.getMonth(), calendarValue?.getDate(), calendarValue?.getHours()]).toEqual([2026, 7, 10, 0])
    expect(calendarValueToLocalDate(calendarValue)).toBe('2026-08-10')
    expect(calendarValueToLocalDate(undefined)).toBe('')
    expect(localDateToCalendarValue('2026-02-30')).toBeUndefined()
  })

  it('拒绝格式错误和不存在的本地日期', () => {
    expect(localDateToMessageSearchRange('2026-8-10')).toBeUndefined()
    expect(localDateToMessageSearchRange('2026-02-30')).toBeUndefined()
    expect(localDateToMessageSearchRange('')).toBeUndefined()
  })
})
