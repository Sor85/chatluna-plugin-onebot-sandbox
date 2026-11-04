/**
 * 记录时间的展示格式。
 *
 * 时区是显式参数而不是隐式的运行时默认值：不给 timeZone 时仍按浏览器本地时区渲染，
 * 与用户看到的一致；测试则必须指名时区，否则「同一时刻算哪一天」会随跑测试的机器变化，
 * 跨日、跨年与午夜这三个边界根本没法断言。
 */
export interface SandboxDateTimeOptions {
  timeZone?: string
}

const INVALID_TIME_TEXT = '—'

export function formatSandboxDateTime(
  value: string | number | Date,
  options: SandboxDateTimeOptions = {},
): string {
  const time = toEpochMs(value)
  // 采集侧可能写入空字符串或被截断的时间戳；渲染成 NaN-NaN-NaN 比缺省符号更难看懂。
  if (time === undefined) return INVALID_TIME_TEXT
  const parts = new Intl.DateTimeFormat('en-US', {
    ...options.timeZone ? { timeZone: options.timeZone } : {},
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23 而不是 hour12: false：后者在部分 ICU 版本下把午夜渲染成 24 点。
    hourCycle: 'h23',
  }).formatToParts(new Date(time))
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`
}

function toEpochMs(value: string | number | Date): number | undefined {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/**
 * 消息气泡上的时刻（时:分）。
 *
 * 与记录时间同一形状——`Intl.DateTimeFormat` 加显式 `timeZone`、非法输入给缺省符号——差别只有
 * 一处：**语言也是参数**。记录时间是机器可比对的时间戳呈现，因此固定成一种格式；气泡上的时刻
 * 是界面文案，要跟着用户环境走（12/24 小时制、分隔符）。两者都遵循同一条规矩：凡是判定依赖
 * 环境隐式提供的东西就提成参数，默认值指向真实环境（ADR 0075）。
 *
 * 不给参数时与浏览器默认行为逐字一致，用户看到的文本不变；测试指名时区与语言，
 * 于是跨日、跨年与午夜这三个边界第一次可断言。
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
