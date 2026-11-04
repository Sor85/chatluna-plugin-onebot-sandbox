import { createHash } from 'node:crypto'
import { SandboxMcpError } from './types'

/**
 * 工具参数的取值助手。
 *
 * 测试控制端点按既有决定只把 inputSchema 当文档暴露、两种协议表述都不做参数校验，校验责任落在
 * 工具执行体内部，因此这几个助手同时被工具注册表与测试控制服务读取，单独成文件避免两者互相 import。
 */

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new SandboxMcpError('invalid_arguments', `${name} 不能为空`)
  return value.trim()
}

/** 数值参数的取值约束。`fallback` 缺席即该参数必填。 */
export interface SandboxNumberRange {
  /** 省略该参数时的取值。 */
  fallback?: number
  min?: number
  max?: number
}

/**
 * 数值参数：类型不对显式失败，越界按声明的上下限收敛。
 *
 * 两种非法输入刻意分开处理，因为它们的失败形态完全不同。
 *
 * 类型不对（`'五十'`、`null`、`{}`）此前经 `Number(...)` 变成 NaN，再被 `Math.min`/`Math.max`
 * 原样放行——NaN 参与的比较全为 false。它不报错，只让调用静默退化成另一种行为：`limit` 变成
 * `slice(0, NaN)` 也就是零条会话，`timeoutSeconds` 变成 `setTimeout(NaN)` 也就是立刻超时。
 * 消费者据此得出的是错的结论（「这个操作者没有会话」「机器人没有回复」），而不是一次可重试的失败，
 * 因此必须显式失败，与 `requireImplementation` 拒绝静默回落到默认协议实现同一个理由。
 *
 * 越界（`limit: 10000`）不同：上下限已经写在 inputSchema 的 `minimum`／`maximum` 里，收敛之后
 * 消费者拿到的是一页真实数据加上续页信息，不会得出错的结论。这里收敛而不是拒绝，避免把一个
 * 可继续工作的调用变成失败。
 */
export function requireNumber(value: unknown, name: string, range: SandboxNumberRange = {}): number {
  if (value === undefined) {
    if (range.fallback === undefined) throw new SandboxMcpError('invalid_arguments', `${name} 不能为空`)
    return range.fallback
  }
  // 非有限数一律拒绝：NaN 与 Infinity 参与 clamp 之后仍然是它们自己，会一路流进下游。
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SandboxMcpError('invalid_arguments', `${name} 必须是数值：${JSON.stringify(value)}`)
  }
  return Math.min(Math.max(value, range.min ?? -Infinity), range.max ?? Infinity)
}

/** 可选数值参数：省略即 undefined，出现但类型不对仍然显式失败。 */
export function optionalNumber(value: unknown, name: string, range: SandboxNumberRange = {}): number | undefined {
  return value === undefined ? undefined : requireNumber(value, name, range)
}

/**
 * 可选枚举参数：省略即 undefined，取值集合之外的值显式失败。
 *
 * 此前每处枚举参数各写一句「是这个值就用它、否则 undefined」，于是拼错的取值静默变成「不筛选」
 * 或「用默认排序」。筛选参数被无声忽略最坏：`status: 'faild'` 会返回全部记录，而消费者以为自己
 * 拿到的只有失败记录，据此得出的是错的结论。失败消息里带上取值集合，因此错误本身就是文档。
 */
export function optionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  const text = requireString(value, name)
  if (!(allowed as readonly string[]).includes(text)) {
    throw new SandboxMcpError('invalid_arguments', `${name} 只能取 ${allowed.join('、')}：${text}`)
  }
  return text as T
}

/** 可选布尔参数：省略即 undefined，出现但不是布尔值显式失败。 */
export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new SandboxMcpError('invalid_arguments', `${name} 必须是布尔值：${JSON.stringify(value)}`)
  return value
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SandboxMcpError('invalid_arguments', '工具参数必须是对象')
  return value as Record<string, unknown>
}

/**
 * 参数里的空间标识原文。
 *
 * 非字符串一律视为省略，与空间解析的口径一致；刻意不 trim——事件归属与媒体缓存键取的是原文，
 * 只有空间解析自己会去掉首尾空白。三处读它（调用治理建运行时、等待类按空间过滤事件、记录域
 * 自己解析空间），因此收在这里一份。
 */
export function readSpaceId(args: Record<string, unknown>): string | undefined {
  return typeof args.spaceId === 'string' ? args.spaceId : undefined
}

/**
 * 与键序无关的稳定序列化。
 *
 * 参数指纹经 `argumentsFingerprint` 取它，ChatLuna 对话状态的变化判定也取它：同一份值换个书写
 * 顺序必须得到同一段文本，否则同键重放会被判成「不同参数」、没变化的状态会被判成变化。
 */
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`
  return JSON.stringify(value)
}

/**
 * 调用标注参数：对全部工具生效、只写进测试调用记录、不改变业务语义的键。
 *
 * `testRunId` 由工具注册表统一注入到每个工具的 schema 上，`confirmationToken` 是破坏性操作的执行
 * 凭据。两者都不描述「这次调用要做什么」，因此都不参与参数指纹。
 */
const CALL_ANNOTATION_KEYS: readonly string[] = ['testRunId', 'confirmationToken']

/**
 * 一次调用的业务参数指纹，与键序无关。
 *
 * 幂等键的重放判定与破坏性操作确认令牌的参数绑定都取它，因此两处对「同一份参数」的理解不可能
 * 分叉。同一份参数换个书写顺序必须得到同一个摘要，否则同键重放会被判成「不同参数」。
 *
 * 调用标注参数在求摘要前被剥掉：它们对全部工具生效且鼓励每次调用都带（`testRunId` 是
 * `list_test_call_records` 回溯同一轮编排的唯一维度），一个鼓励普遍携带的标注键不该改变业务判定。
 * 带上它们的后果是两条本该成功的路径静默失败——签发令牌时没写 `testRunId`、实际调用带了它，
 * 确认会被判成失败；同一幂等键换一个 `testRunId` 重放，会被判成幂等冲突。见 ADR-0097。
 */
export function argumentsFingerprint(args: Record<string, unknown>): string {
  const business = Object.fromEntries(Object.entries(args).filter(([key]) => !CALL_ANNOTATION_KEYS.includes(key)))
  return createHash('sha256').update(stableValue(business)).digest('hex')
}
