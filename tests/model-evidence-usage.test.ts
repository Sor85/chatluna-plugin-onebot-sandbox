import { describe, expect, it } from 'vitest'
import { projectModelEvidence } from '../src/model-evidence'

function openAiUsage(usage: Record<string, unknown>) {
  return usageCandidate(JSON.stringify({ choices: [{ message: { content: '回复' } }], usage }))
}

function anthropicUsage(usage: Record<string, unknown>) {
  return usageCandidate(JSON.stringify({ type: 'message', content: [{ type: 'text', text: '回复' }], usage }))
}

function geminiUsage(usageMetadata: Record<string, unknown>) {
  return usageCandidate(JSON.stringify({ candidates: [{ content: { parts: [{ text: '回复' }] } }], usageMetadata }))
}

function usageCandidate(responseBodyRaw: string) {
  const { responseEvents } = projectModelEvidence({ responseBodyRaw, responseBodyFormat: 'json' })
  return responseEvents.find(({ kind }) => kind === 'usage')?.normalizedUsage
}

/**
 * 响应体用量候选的回归 prior art。
 *
 * ADR-0059 的优先级由调用方负责；这里只锁定共享投影从响应体能证明出的候选值，
 * 保证把用量归一化从客户端搬进共享 module 后统计结果没有变化。
 */
describe('模型证据投影 · 响应体用量候选', () => {
  it('把 OpenAI、Anthropic 和 Gemini 用量统一为顶部统计', () => {
    expect(openAiUsage({
      prompt_tokens: 26512,
      completion_tokens: 705,
      total_tokens: 27217,
      prompt_tokens_details: { cached_tokens: 20607 },
      completion_tokens_details: { reasoning_tokens: 483 },
    })).toEqual({
      inputTokens: 26512,
      outputTokens: 222,
      reasoningTokens: 483,
      cachedTokens: 20607,
      totalTokens: 27217,
    })

    expect(anthropicUsage({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    })).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      reasoningTokens: undefined,
      cachedTokens: 100,
      totalTokens: 240,
    })

    expect(geminiUsage({
      promptTokenCount: 1000,
      candidatesTokenCount: 200,
      thoughtsTokenCount: 50,
      cachedContentTokenCount: 700,
      totalTokenCount: 1250,
    })).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
      cachedTokens: 700,
      totalTokens: 1250,
    })

    expect(geminiUsage({
      promptTokenCount: 10664,
      candidatesTokenCount: 125,
      totalTokenCount: 11511,
      cachedContentTokenCount: 8051,
      thoughtsTokenCount: 722,
    })).toEqual({
      inputTokens: 10664,
      outputTokens: 125,
      reasoningTokens: 722,
      cachedTokens: 8051,
      totalTokens: 11511,
    })

    // 部分网关把 completion_tokens 报成与 reasoning 相同，可见输出只体现在 total_tokens。
    expect(openAiUsage({
      prompt_tokens: 14228,
      completion_tokens: 406,
      total_tokens: 14852,
      completion_tokens_details: { reasoning_tokens: 406 },
    })).toEqual({
      inputTokens: 14228,
      outputTokens: 218,
      reasoningTokens: 406,
      cachedTokens: undefined,
      totalTokens: 14852,
    })

    expect(openAiUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      completion_tokens_details: { reasoning_tokens: 40 },
    })).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      reasoningTokens: 40,
      cachedTokens: undefined,
      totalTokens: 140,
    })
  })

  it('合并流式 usage，避免后到的残缺片段把输出覆盖成 0', () => {
    const { responseEvents } = projectModelEvidence({
      responseBodyRaw: [
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '你好' } }],
          usage: {
            prompt_tokens: 14228,
            completion_tokens: 624,
            total_tokens: 14852,
            completion_tokens_details: { reasoning_tokens: 406 },
          },
        })}`,
        '',
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '' } }],
          usage: {
            prompt_tokens: 14228,
            completion_tokens: 406,
            total_tokens: 14852,
            completion_tokens_details: { reasoning_tokens: 406 },
          },
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      responseBodyFormat: 'sse',
    })

    expect(responseEvents.find(({ kind }) => kind === 'content')?.text).toBe('你好')
    expect(responseEvents.find(({ kind }) => kind === 'usage')?.normalizedUsage).toEqual({
      inputTokens: 14228,
      outputTokens: 218,
      reasoningTokens: 406,
      cachedTokens: undefined,
      totalTokens: 14852,
    })
    // 合并后的用量事件保留全部参与来源，方便回到具体 SSE 分片核对。
    expect(responseEvents.find(({ kind }) => kind === 'usage')?.sources.map(({ path }) => path.join('.'))).toEqual([
      '0.data.usage',
      '1.data.usage',
    ])
  })
})
