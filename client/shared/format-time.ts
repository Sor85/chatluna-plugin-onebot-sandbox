const INVALID_TIME_TEXT = '—'

/**
 * 消息气泡上的时刻（时:分）。
 *
 * 时区与语言是显式参数而不是隐式的运行时默认值：不给参数时与浏览器默认行为逐字一致，
 * 跟着用户环境走（12/24 小时制、分隔符）；测试则必须指名时区与语言，否则「同一时刻算哪一天」
 * 会随跑测试的机器变化，跨日、跨年与午夜这三个边界没法断言。
 */
export interface SandboxTimeOfDayOptions {
  timeZone?: string
  locale?: string
}

/**
 * 格式化器按「语言 + 时区」缓存。
 *
 * 保留窗口内消息条数上限两千，而气泡时间是逐条渲染的；每条现造一个 `Intl.DateTimeFormat`
 * 会让格式化器的构造次数随渲染次数放大。缓存键必须同时含时区，否则换时区会拿到上一个的结果。
 */
const timeOfDayFormatters = new Map<string, Intl.DateTimeFormat>()

function readTimeOfDayFormatter(options: SandboxTimeOfDayOptions): Intl.DateTimeFormat {
  const key = `${options.locale ?? ''}|${options.timeZone ?? ''}`
  const cached = timeOfDayFormatters.get(key)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat(options.locale ?? [], {
    ...options.timeZone ? { timeZone: options.timeZone } : {},
    hour: '2-digit',
    minute: '2-digit',
  })
  timeOfDayFormatters.set(key, formatter)
  return formatter
}

export function formatSandboxTimeOfDay(
  value: string | number | Date,
  options: SandboxTimeOfDayOptions = {},
): string {
  const time = toEpochMs(value)
  // 采集侧可能写入空字符串或被截断的时间戳；缺省符号比 "Invalid Date" 更容易读懂。
  if (time === undefined) return INVALID_TIME_TEXT
  return readTimeOfDayFormatter(options).format(new Date(time))
}

function toEpochMs(value: string | number | Date): number | undefined {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}
