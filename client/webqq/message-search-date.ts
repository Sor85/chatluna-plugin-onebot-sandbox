export interface MessageSearchDateRange {
  createdAtStart: string
  createdAtEnd: string
}

/** `YYYY-MM-DD` 本地日历日 → 日历控件使用的本地零点 Date；格式或日期非法时返回 undefined。 */
export function localDateToCalendarValue(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.getDate() === Number(match[3]) ? date : undefined
}

export function calendarValueToLocalDate(value: Date | undefined): string {
  if (!value) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

export function localDateToMessageSearchRange(value: string): MessageSearchDateRange | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const start = new Date(year, month - 1, day)
  if (
    start.getFullYear() !== year
    || start.getMonth() !== month - 1
    || start.getDate() !== day
  ) return undefined

  // 按本地日历推进到次日零点，不能固定加 24 小时，否则夏令时切换日会偏移。
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return {
    createdAtStart: start.toISOString(),
    createdAtEnd: end.toISOString(),
  }
}
