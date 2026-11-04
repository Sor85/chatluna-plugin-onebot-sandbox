import type { SandboxModelRequestStore } from './model-request'

const PREVIEW_INTERACTION_PREFIX = 'dev-chatluna-error-preview:'

interface DevelopmentErrorPreview {
  code: number
  title: string
  originMessage: string
  responseStatus: number
  isTimeout?: boolean
}

const PREVIEW_ERRORS: readonly DevelopmentErrorPreview[] = [
  { code: 1, title: '网络错误', originMessage: 'connect ECONNREFUSED 127.0.0.1:443', responseStatus: 502 },
  { code: 2, title: '代理配置错误', originMessage: 'Unsupported proxy protocol: ftp:', responseStatus: 500 },
  { code: 100, title: 'API Key 不可用', originMessage: 'The supplied API key is invalid.', responseStatus: 401 },
  { code: 101, title: '需要验证码', originMessage: 'Captcha verification required before continuing.', responseStatus: 403 },
  { code: 102, title: 'API 请求超时', originMessage: 'The request timed out after 60 seconds.', responseStatus: 504, isTimeout: true },
  { code: 103, title: 'API 请求失败', originMessage: 'The upstream provider rejected this request.', responseStatus: 400 },
  { code: 104, title: '不安全内容', originMessage: 'Unsafe content detected in the conversation.', responseStatus: 400 },
  { code: 301, title: '模型不可用', originMessage: 'Model preview-model-301 was not found.', responseStatus: 404 },
  { code: 303, title: '模型初始化失败', originMessage: 'Failed to initialize the selected model.', responseStatus: 500 },
  { code: 307, title: '无可用配置', originMessage: 'No available model configuration remains.', responseStatus: 503 },
  { code: 309, title: '模型空响应', originMessage: 'The model returned an empty response.', responseStatus: 502 },
] as const

/**
 * 直接写进记录库而不是经控制服务：这条便利仅在开发模式下生效，不值得在对外 interface 上占一个键。
 */
export async function seedDevelopmentModelRequestErrors(store: SandboxModelRequestStore): Promise<number> {
  if (process.env.NODE_ENV !== 'development') return 0
  await store.waitForPersistence()
  let created = 0
  for (const preview of PREVIEW_ERRORS) {
    const interactionId = `${PREVIEW_INTERACTION_PREFIX}${preview.code}`
    if ((await store.getRecords({ interactionId, limit: 1 })).records.length) continue
    const model = `error-preview-${preview.code}`
    store.append({
      status: 'error',
      durationMs: preview.code === 102 ? 60_000 : 120 + preview.code,
      method: 'POST',
      url: 'https://preview.invalid/v1/chat/completions',
      provider: `ChatLuna ${preview.code}`,
      model,
      attribution: 'attributed',
      entities: {
        scopeId: 'main',
        botId: '20001',
        conversationId: 'private:10001:20001',
      },
      requestBodyAvailable: true,
      requestBody: {
        model,
        messages: [{ role: 'user', content: `开发预览：${preview.title}（ChatLuna ${preview.code}）` }],
      },
      responseStatus: preview.responseStatus,
      responseBodyStatus: 'complete',
      responseBodyFormat: 'json',
      responseBodyRaw: JSON.stringify({
        error: {
          code: preview.code,
          message: preview.originMessage,
          fixture: 'development-only',
        },
      }),
      interactionId,
      error: {
        code: preview.isTimeout ? 'transient_error' : 'model_request_error',
        message: `HTTP ${preview.responseStatus}`,
        retryable: preview.code === 1 || preview.code === 2 || preview.code === 102 || preview.responseStatus >= 500,
        traceId: `dev-preview-${preview.code}`,
      },
      chatlunaError: {
        code: preview.code,
        message: `${preview.title} (${preview.code})`,
        originMessage: preview.originMessage,
        ...(preview.isTimeout ? { isTimeout: true } : {}),
      },
    })
    created += 1
  }
  await store.waitForPersistence()
  return created
}
