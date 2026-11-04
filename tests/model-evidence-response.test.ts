import { describe, expect, it } from 'vitest'
import { projectModelEvidence } from '../src/model-evidence'
import type { ModelEvidenceResponseEvent } from '../src/model-evidence'
import {
  anthropicMessagesJsonResponse,
  geminiCandidatesJsonResponse,
  openAiChatJsonResponse,
  openAiChatSseResponse,
  openAiResponsesJsonResponse,
} from './fixtures/model-protocol-fixtures'

function shape(events: readonly ModelEvidenceResponseEvent[]) {
  return events.map(({ kind, text, name, callId }) => ({
    kind,
    ...(text === undefined ? {} : { text }),
    ...(name === undefined ? {} : { name }),
    ...(callId === undefined ? {} : { callId }),
  }))
}

function sourcePaths(event: ModelEvidenceResponseEvent | undefined) {
  return event?.sources.map(({ path }) => path.join('.')) ?? []
}

describe('模型证据投影 · 模型响应语义事件', () => {
  it('把 OpenAI Chat Completions JSON 响应投影为正文、思考、工具调用、结束原因与用量候选', () => {
    const { responseEvents, responseTransport, diagnostics } = projectModelEvidence({
      responseBodyRaw: openAiChatJsonResponse,
      responseBodyFormat: 'json',
    })

    expect(responseTransport.kind).toBe('json')
    expect(shape(responseEvents)).toEqual([
      { kind: 'reasoning', text: '读取工具结果' },
      { kind: 'content', text: '北京今天晴朗' },
      { kind: 'tool-call', name: 'forecast', callId: 'call-9' },
      { kind: 'finish-reason', text: 'tool_calls' },
      { kind: 'usage' },
    ])
    expect(responseEvents[2]?.arguments).toBe('{"city":"北京"}')
    expect(responseEvents.at(-1)?.normalizedUsage).toMatchObject({ inputTokens: 20, outputTokens: 8, totalTokens: 28 })
    expect(sourcePaths(responseEvents[1])).toEqual(['choices.0.message.content'])
    expect(diagnostics).toEqual([])
  })

  it('把 Anthropic content 块投影为思考、正文、工具调用与结束原因', () => {
    const { responseEvents } = projectModelEvidence({
      responseBodyRaw: anthropicMessagesJsonResponse,
      responseBodyFormat: 'json',
    })

    expect(shape(responseEvents)).toEqual([
      { kind: 'reasoning', text: '推理内容' },
      { kind: 'content', text: 'Anthropic 正文' },
      { kind: 'tool-call', name: 'lookup', callId: 'tool-9' },
      { kind: 'finish-reason', text: 'tool_use' },
      { kind: 'usage' },
    ])
    expect(responseEvents.at(-1)?.normalizedUsage).toMatchObject({ inputTokens: 15, outputTokens: 4, cachedTokens: 3 })
    expect(sourcePaths(responseEvents[1])).toEqual(['content.1.text'])
  })

  it('把 Gemini candidates 的思考片段、正文、functionCall 与 finishReason 分开投影', () => {
    const { responseEvents } = projectModelEvidence({
      responseBodyRaw: geminiCandidatesJsonResponse,
      responseBodyFormat: 'json',
    })

    expect(shape(responseEvents)).toEqual([
      { kind: 'reasoning', text: '思考片段' },
      { kind: 'content', text: 'Gemini 正文' },
      { kind: 'tool-call', name: 'lookup' },
      { kind: 'finish-reason', text: 'STOP' },
      { kind: 'usage' },
    ])
    expect(responseEvents[2]?.callId).toBeUndefined()
    expect(responseEvents.at(-1)?.normalizedUsage).toMatchObject({ inputTokens: 30, outputTokens: 6, reasoningTokens: 2 })
  })

  it('把 OpenAI Responses output 的推理、正文、function call 与 function call output 投影为独立事件', () => {
    const { responseEvents } = projectModelEvidence({
      responseBodyRaw: openAiResponsesJsonResponse,
      responseBodyFormat: 'json',
    })

    expect(shape(responseEvents)).toEqual([
      { kind: 'reasoning', text: 'Responses 推理' },
      { kind: 'content', text: 'Responses 正文' },
      { kind: 'tool-call', name: 'lookup', callId: 'call-7' },
      { kind: 'tool-result', name: 'lookup', callId: 'call-7', text: '{\n  "ok": true\n}' },
      { kind: 'usage' },
    ])
    expect(sourcePaths(responseEvents[3])).toEqual(['output.3'])
  })

  it('SSE transport 保留事件顺序，合并已知 delta 并保留全部参与来源', () => {
    const { responseEvents, responseTransport } = projectModelEvidence({
      responseBodyRaw: openAiChatSseResponse,
      responseBodyFormat: 'sse',
    })

    expect(responseTransport.kind).toBe('sse')
    expect(responseTransport.value).toEqual([
      { event: 'message', data: { choices: [{ delta: { reasoning_content: '思' } }] } },
      { event: 'message', data: { choices: [{ delta: { reasoning_content: '考' } }] } },
      { event: 'message', data: { choices: [{ delta: { content: '北' } }] } },
      { event: 'message', data: { choices: [{ delta: { content: '京晴' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
      { event: 'message', data: '[DONE]' },
    ])
    expect(shape(responseEvents)).toEqual([
      { kind: 'reasoning', text: '思考' },
      { kind: 'content', text: '北京晴' },
      { kind: 'finish-reason', text: 'stop' },
      { kind: 'usage' },
    ])
    expect(sourcePaths(responseEvents[0])).toEqual([
      '0.data.choices.0.delta.reasoning_content',
      '1.data.choices.0.delta.reasoning_content',
    ])
  })

  it('合并流式工具调用参数，缺少调用标识的后续分片不会另开一条事件', () => {
    const { responseEvents } = projectModelEvidence({
      responseBodyRaw: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{\\"a\\""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
        '',
      ].join('\n'),
      responseBodyFormat: 'sse',
    })

    expect(responseEvents).toHaveLength(1)
    expect(responseEvents[0]).toMatchObject({
      kind: 'tool-call',
      name: 'lookup',
      callId: 'call-1',
      arguments: '{"a":1}',
    })
    expect(sourcePaths(responseEvents[0])).toHaveLength(2)
  })

  it('累计 SSE 快照去重，同一工具结果和正文不会重复出现', () => {
    const { responseEvents } = projectModelEvidence({
      responseBodyRaw: [
        'data: {"output":[{"type":"message","content":[{"type":"output_text","text":"北"}]},{"type":"function_call_output","call_id":"call-9","name":"lookup","output":{"ok":true}}],"metadata":{"type":"tool_result","content":"不是模型工具结果"}}',
        '',
        'data: {"output":[{"type":"message","content":[{"type":"output_text","text":"北京"}]},{"type":"function_call_output","call_id":"call-9","name":"lookup","output":{"ok":true}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      responseBodyFormat: 'sse',
    })

    expect(shape(responseEvents)).toEqual([
      { kind: 'content', text: '北京' },
      { kind: 'tool-result', name: 'lookup', callId: 'call-9', text: '{\n  "ok": true\n}' },
    ])
    expect(sourcePaths(responseEvents[1])).toEqual(['0.data.output.1', '1.data.output.1'])
  })

  it('TEXT transport 保留可见正文与原始证据，不判定为空响应', () => {
    const projection = projectModelEvidence({
      responseBodyRaw: '<b>原样文本，不执行 HTML</b>',
      responseBodyFormat: 'text',
    })

    expect(projection.responseTransport).toEqual({ kind: 'text', value: '<b>原样文本，不执行 HTML</b>' })
    expect(shape(projection.responseEvents)).toEqual([{ kind: 'content', text: '<b>原样文本，不执行 HTML</b>' }])
    expect(projection.diagnostics).toEqual([])
  })

  it('空响应既不产生事件也不产生诊断', () => {
    expect(projectModelEvidence({ responseBodyRaw: '', responseBodyFormat: 'json' })).toMatchObject({
      responseEvents: [],
      responseTransport: { kind: 'empty' },
      diagnostics: [],
    })
    expect(projectModelEvidence({}).responseTransport).toEqual({ kind: 'empty' })
  })

  it('损坏 JSON 返回结构化诊断并保留原文', () => {
    const { responseEvents, responseTransport, diagnostics } = projectModelEvidence({
      responseBodyRaw: '{broken',
      responseBodyFormat: 'json',
    })

    expect(responseTransport).toEqual({ kind: 'text', value: '{broken' })
    expect(responseEvents).toEqual([])
    expect(diagnostics).toEqual([
      { code: 'response-body-malformed', severity: 'error', source: { region: 'response', path: [], value: '{broken' } },
    ])
  })

  it('局部损坏的 SSE 事件只影响自身，其他可证明内容继续投影', () => {
    const { responseEvents, diagnostics } = projectModelEvidence({
      responseBodyRaw: [
        'data: {"choices":[{"delta":{"content":"可用"}}]}',
        '',
        'data: {不是 JSON',
        '',
      ].join('\n'),
      responseBodyFormat: 'sse',
    })

    expect(shape(responseEvents)).toEqual([{ kind: 'content', text: '可用' }])
    expect(diagnostics).toEqual([
      { code: 'response-body-malformed', severity: 'error', source: expect.objectContaining({ region: 'response', path: ['1', 'data'] }) },
    ])
  })

  it('未识别的 SSE payload 保留为未识别证据，不通过字符串拼接猜测语义', () => {
    const { responseEvents, diagnostics } = projectModelEvidence({
      responseBodyRaw: [
        'data: {"weird":{"text":"不要拼接我"}}',
        '',
        'data: {"choices":[{"delta":{"content":"可用"}}]}',
        '',
      ].join('\n'),
      responseBodyFormat: 'sse',
    })

    expect(shape(responseEvents)).toEqual([
      { kind: 'unknown' },
      { kind: 'content', text: '可用' },
    ])
    expect(responseEvents[0]?.text).toBeUndefined()
    expect(diagnostics).toEqual([
      { code: 'response-payload-unsupported', severity: 'warning', source: expect.objectContaining({ path: ['0', 'data'] }) },
    ])
  })

  it('同一响应节点被多个同等可信 adapter 匹配时报告歧义，不生成重复事件', () => {
    const { responseEvents, diagnostics } = projectModelEvidence({
      responseBodyRaw: JSON.stringify({
        choices: [{ message: { content: 'OpenAI 正文' } }],
        candidates: [{ content: { parts: [{ text: 'Gemini 正文' }] } }],
      }),
      responseBodyFormat: 'json',
    })

    expect(shape(responseEvents)).toEqual([{ kind: 'unknown' }])
    expect(diagnostics).toEqual([
      { code: 'response-payload-ambiguous', severity: 'warning', source: expect.objectContaining({ path: [] }) },
    ])
  })

  it('响应工具调用与工具结果只保留显式调用标识，不按名称或位置配对', () => {
    const { responseEvents } = projectModelEvidence({
      responseBodyRaw: JSON.stringify({
        output: [
          { type: 'function_call', name: 'lookup', arguments: '{}' },
          { type: 'function_call_output', name: 'lookup', output: '结果' },
        ],
      }),
      responseBodyFormat: 'json',
    })

    expect(responseEvents.map(({ kind, callId }) => ({ kind, callId }))).toEqual([
      { kind: 'tool-call', callId: undefined },
      { kind: 'tool-result', callId: undefined },
    ])
  })

  it('相同响应证据得到确定性身份，不同语义项即使共享父节点也不冲突', () => {
    const slice = { responseBodyRaw: anthropicMessagesJsonResponse, responseBodyFormat: 'json' } as const
    const first = projectModelEvidence(slice)
    const second = projectModelEvidence(slice)

    expect(first.responseEvents.map(({ evidenceId }) => evidenceId))
      .toEqual(second.responseEvents.map(({ evidenceId }) => evidenceId))
    expect(new Set(first.responseEvents.map(({ evidenceId }) => evidenceId)).size).toBe(first.responseEvents.length)
  })

  it('pending 请求补齐分片后已存在的证据身份保持稳定', () => {
    const partial = projectModelEvidence({
      responseBodyRaw: 'data: {"choices":[{"delta":{"content":"北"}}]}\n\n',
      responseBodyFormat: 'sse',
    })
    const complete = projectModelEvidence({
      responseBodyRaw: openAiChatSseResponse,
      responseBodyFormat: 'sse',
    })

    expect(partial.responseEvents[0]?.evidenceId)
      .toBe(complete.responseEvents.find(({ kind }) => kind === 'content')?.evidenceId)
  })

  it('响应投影持有原始子树引用，请求与响应事件互不干扰', () => {
    const projection = projectModelEvidence({
      requestBody: { messages: [{ role: 'user', content: '问' }] },
      responseBodyRaw: openAiChatJsonResponse,
      responseBodyFormat: 'json',
    })

    expect(projection.requestMessages).toHaveLength(1)
    expect(projection.responseEvents.every(event => event.sources.every(({ region }) => region === 'response'))).toBe(true)
    expect(projection.requestMessages.every(message => message.sources.every(({ region }) => region === 'request'))).toBe(true)
  })
})
