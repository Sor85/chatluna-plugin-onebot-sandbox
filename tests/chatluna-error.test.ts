import { describe, expect, it } from 'vitest'
import {
  archiveChatLunaModelRequestError,
  findLatestFailedModelRequest,
  getChatLunaErrorPossibleCauses,
  readChatLunaRequestError,
} from '../src/chatluna/error'
import { SandboxModelRequestStore } from '../src/model-request'
import type { SandboxModelRequestDetail } from '../src/types'

function record(sequence: number, input: Partial<SandboxModelRequestDetail> = {}): SandboxModelRequestDetail {
  return {
    id: `request-${sequence}`,
    sequence,
    createdAt: new Date(sequence * 1000).toISOString(),
    status: 'error',
    durationMs: 1,
    attribution: 'attributed',
    entities: {},
    requestBodyAvailable: true,
    requestBody: {},
    responseBodyStatus: 'unavailable',
    variables: [],
    ...input,
  }
}

describe('ChatLuna 模型请求错误', () => {
  it('提取 ChatLuna 错误码、消息、原始原因和 timeout 标记', () => {
    expect(readChatLunaRequestError({
      errorCode: 102,
      message: 'API 请求超时 (102)',
      originError: new Error('upstream timed out after 60s'),
      isTimeout: true,
      data: { ignored: true },
    })).toEqual({
      code: 102,
      message: 'API 请求超时 (102)',
      originMessage: 'upstream timed out after 60s',
      isTimeout: true,
    })
    expect(readChatLunaRequestError(null)).toBeUndefined()
  })

  it('按官方错误码返回可能原因，不根据裸 HTTP 状态推断', () => {
    expect(getChatLunaErrorPossibleCauses({ code: 100 })).toContain('API Key 不可用或无效，请确认密钥仍可正常使用。')
    expect(getChatLunaErrorPossibleCauses({ code: 103 })[0]).toContain('覆盖范围较广')
    expect(getChatLunaErrorPossibleCauses(undefined)).toEqual([])
    expect(getChatLunaErrorPossibleCauses({ code: 999 })).toEqual([])
  })

  it('优先选择同一逻辑会话最近的失败请求，并跳过已经关联的记录', () => {
    const records = [
      record(1, { entities: { conversationId: 'conversation-a' } }),
      record(2, { entities: { conversationId: 'conversation-b' } }),
      record(3, {
        entities: { conversationId: 'conversation-a' },
        chatlunaError: { code: 103 },
      }),
    ]
    expect(findLatestFailedModelRequest(records, 'conversation-a')?.id).toBe('request-1')
    expect(findLatestFailedModelRequest(records, 'conversation-missing')?.id).toBe('request-2')
  })
})

/**
 * 失败回填住在本 module 而不是记录库里：记录库不该认识 ChatLuna 的错误格式。
 * 它依赖的两件事（解析上游错误、找到最近一条失败记录）都在这里。
 */
describe('ChatLuna 失败记录回填', () => {
  function failed(store: SandboxModelRequestStore, model: string, conversationId: string) {
    return store.append({
      status: 'error',
      durationMs: 10,
      model,
      attribution: 'attributed',
      entities: { conversationId },
      requestBodyAvailable: false,
      error: { code: 'model_request_error', message: 'HTTP 500', retryable: false, traceId: `${model}-trace` },
    })
  }

  it('回填该会话最近一条失败记录，且这次更新被收尾等待覆盖', async () => {
    const store = new SandboxModelRequestStore()
    const target = failed(store, 'direct-model', 'private:10001:20001')
    const other = failed(store, 'group-model', 'group:30001')

    archiveChatLunaModelRequestError(store, {
      errorCode: 103,
      message: 'API 请求失败 (103)',
      originError: new Error('provider rejected request'),
    }, { conversationId: 'private:10001:20001' })

    // 查找与单行更新只在后台完成；这里除了收尾等待没有别的同步手段，等到即证明它被覆盖。
    await store.waitForPersistence()
    expect((await store.getRecord(target.id))?.chatlunaError).toEqual({
      code: 103,
      message: 'API 请求失败 (103)',
      originMessage: 'provider rejected request',
    })
    expect((await store.getRecord(other.id))?.chatlunaError).toBeUndefined()
  })

  it('上游错误里没有可用信息时不回填，也不留下待办更新', async () => {
    const store = new SandboxModelRequestStore()
    const target = failed(store, 'direct-model', 'private:10001:20001')

    archiveChatLunaModelRequestError(store, undefined, { conversationId: 'private:10001:20001' })

    await store.waitForPersistence()
    expect((await store.getRecord(target.id))?.chatlunaError).toBeUndefined()
  })
})
