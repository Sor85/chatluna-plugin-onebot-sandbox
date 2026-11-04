import { describe, expect, it } from 'vitest'
import { SandboxModelRequestStore } from '../src/model-request'
import {
  linkChatLunaUsageRequest,
  lookupChatLunaUsage,
  toSandboxModelRequestUsage,
  type ChatLunaUsageLookup,
} from '../src/chatluna/usage'

describe('ChatLuna Usage 模型请求关联', () => {
  it('把 chatluna-usage 行转换为模型请求详情用量', async () => {
    expect(toSandboxModelRequestUsage({
      inputTokens: 14228,
      outputTokens: 218,
      reasoningTokens: 406,
      cachedTokens: 8192,
      totalTokens: 14852,
      estimated: false,
      model: 'gpt-5',
      createdAt: '2026-08-17T00:00:00.000Z',
      ttftMs: 321,
      totalMs: 4800,
      tps: 45.42,
      requestId: 'request-1',
    })).toEqual({
      inputTokens: 14228,
      outputTokens: 218,
      reasoningTokens: 406,
      cachedTokens: 8192,
      totalTokens: 14852,
      ttftMs: 321,
      totalMs: 4800,
      tps: 45.42,
      estimated: false,
      source: 'chatluna-usage',
    })
  })

  it('在 model-usage 事件到达时把 ChatLuna requestId 关联到最近请求', async () => {
    const store = new SandboxModelRequestStore()
    const record = store.append({
      status: 'success',
      durationMs: 1200,
      model: 'gpt-5',
      attribution: 'unattributed',
      entities: {},
      requestBodyAvailable: false,
    })

    expect(await linkChatLunaUsageRequest([store], {
      model: 'gpt-5',
      createdAt: record.createdAt,
      context: { requestId: 'chatluna-request-1' },
    })).toBe(record.id)
    expect((await store.getRecord(record.id))?.chatlunaRequestId).toBe('chatluna-request-1')
  })

  it('优先按 requestId 从 chatluna-usage 读取规范用量', async () => {
    const requested: unknown[] = []
    const service: ChatLunaUsageLookup = {
      async list(input) {
        requested.push(input)
        return {
          rows: [{
            inputTokens: 100,
            outputTokens: 40,
            reasoningTokens: 20,
            cachedTokens: 80,
            totalTokens: 160,
            model: 'gpt-5',
            createdAt: '2026-08-17T00:00:01.000Z',
            requestId: 'chatluna-request-1',
            ttftMs: 200,
            totalMs: 1000,
            tps: 40,
          }],
        }
      },
    }

    await expect(lookupChatLunaUsage(service, {
      createdAt: '2026-08-17T00:00:00.000Z',
      durationMs: 1000,
      model: 'gpt-5',
      chatlunaRequestId: 'chatluna-request-1',
    })).resolves.toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 20,
      cachedTokens: 80,
      ttftMs: 200,
      totalMs: 1000,
      tps: 40,
      source: 'chatluna-usage',
    })
    expect(requested).toHaveLength(1)
  })
})
