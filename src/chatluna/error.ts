import type { SandboxModelRequestStore } from '../model-request'
import type { SandboxChatLunaRequestError, SandboxModelRequestRecord } from '../types'

export const CHATLUNA_ERROR_CODE_DOCUMENTATION_URL = 'https://chatluna.chat/guide/faq/error_code.html'

const CHATLUNA_ERROR_CAUSES: Readonly<Record<number, readonly string[]>> = {
  1: ['网络连接或代理配置异常。'],
  2: ['代理地址或代理协议无效，请检查代理 URL 的协议和格式。'],
  100: ['API Key 不可用或无效，请确认密钥仍可正常使用。'],
  101: ['服务商要求完成验证码，请登录对应服务手动验证。'],
  102: ['网络连接、代理配置或 API Key 异常。', '模型响应较慢、上下文较长或代理延迟较高；确认这些情况后可适当增加超时时间。'],
  103: ['网络连接、代理配置或 API Key 异常；该错误码覆盖范围较广，请结合下方原始原因和响应原文继续判断。'],
  104: ['请求或对话中包含不安全内容，请新建会话后重试。'],
  301: ['模型不可用、模型名称不存在，或适配器初始化失败。'],
  303: ['模型初始化失败，请检查模型配置和网络连接。'],
  307: ['当前没有可用的模型配置；可先新建会话，再检查模型、嵌入模型和向量数据库配置。'],
  309: ['模型返回空响应；请检查 API、网络和密钥，并确认对话或预设内容未被模型拒绝。'],
}

export function readChatLunaRequestError(error: unknown): SandboxChatLunaRequestError | undefined {
  const value = readRecord(error)
  if (!value) return
  const code = readFiniteNumber(value.errorCode)
  const message = readNonEmptyString(value.message)
  const originMessage = readOriginMessage(value.originError)
  const isTimeout = value.isTimeout === true
  if (code === undefined && !message && !originMessage && !isTimeout) return
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message ? { message } : {}),
    ...(originMessage && originMessage !== message ? { originMessage } : {}),
    ...(isTimeout ? { isTimeout: true } : {}),
  }
}

export function getChatLunaErrorPossibleCauses(
  error: Pick<SandboxChatLunaRequestError, 'code'> | undefined,
): readonly string[] {
  if (error?.code === undefined) return []
  return CHATLUNA_ERROR_CAUSES[error.code] ?? []
}

export function findLatestFailedModelRequest(
  records: readonly SandboxModelRequestRecord[],
  conversationId?: string,
): SandboxModelRequestRecord | undefined {
  const candidates = records
    .filter(record => record.status === 'error' && !record.chatlunaError)
    .sort((left, right) => right.sequence - left.sequence)
  if (conversationId) {
    const matchingConversation = candidates.find(record => record.entities.conversationId === conversationId)
    if (matchingConversation) return matchingConversation
  }
  return candidates[0]
}

/**
 * 把一次 ChatLuna 上游错误回填到该会话最近一条失败记录上。
 *
 * 住在这里而不是记录库里：记录库不该认识 ChatLuna 的错误格式。它需要的两件事——解析上游错误、
 * 找到「最近一条失败记录」——都已经在本 module 里，回填只是把两者接上记录库的单行更新。
 */
export function archiveChatLunaModelRequestError(
  store: SandboxModelRequestStore,
  error: unknown,
  target: { readonly conversationId: string },
): void {
  const chatlunaError = readChatLunaRequestError(error)
  if (!chatlunaError) return
  // ChatLuna 的错误回调是同步的，记录查找与单行更新只能在后台完成；
  // 收尾等待通过 trackUpdate 覆盖它，避免关机时丢掉这次归档。
  const task = store.getRawRecords().then(async (records) => {
    const record = findLatestFailedModelRequest(records, target.conversationId)
    if (!record) return
    await store.update(record.id, { chatlunaError })
  }).catch(() => undefined)
  store.trackUpdate(task)
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readOriginMessage(origin: unknown): string | undefined {
  const record = readRecord(origin)
  return readNonEmptyString(record?.message) ?? readNonEmptyString(origin)
}
