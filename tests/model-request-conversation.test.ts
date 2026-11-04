import { describe, expect, it } from 'vitest'
import { parseModelRequestConversationDetail } from '../client/model-request/conversation'
import type { SandboxModelRequestDetail } from '../src/types'

function detail(overrides: Partial<SandboxModelRequestDetail>): SandboxModelRequestDetail {
  return {
    id: 'request-1', sequence: 1, createdAt: '2026-08-19T12:00:00.000Z', status: 'success', durationMs: 120,
    attribution: 'unattributed', entities: {}, requestBodyAvailable: true, responseBodyStatus: 'unavailable',
    variables: [],
    ...overrides,
  }
}

describe('模型请求对话视图归一化', () => {
  it('归一化 Chat Completions 消息、调用结果与工具定义并保留源路径', () => {
    const conversation = parseModelRequestConversationDetail(detail({ requestBody: {
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: '系统规则' },
        { role: 'user', content: '查天气' },
        { role: 'assistant', content: '正在查询', tool_calls: [{ id: 'call-1', function: { name: 'weather', arguments: '{"city":"北京"}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: '{"weather":"晴"}' },
      ],
      tools: [{ type: 'function', function: { name: 'weather', description: '查询天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    } }))

    expect(conversation.messages.map(({ index, kind, path }) => ({ index, kind, path }))).toEqual([
      { index: 0, kind: 'system', path: ['messages', '0'] },
      { index: 1, kind: 'user', path: ['messages', '1'] },
      { index: 2, kind: 'assistant', path: ['messages', '2'] },
      // tool 角色的请求消息就是请求里携带的工具结果，卡片按这一档基础证据种类归类。
      { index: 3, kind: 'tool-result', path: ['messages', '3'] },
    ])
    expect(conversation.messages[2]?.toolCalls[0]).toMatchObject({ id: 'call-1', name: 'weather', arguments: '{"city":"北京"}' })
    expect(conversation.messages[3]?.toolCallId).toBe('call-1')
    expect(conversation.tools[0]).toMatchObject({ name: 'weather', description: '查询天气', path: ['tools', '0', 'function'] })
  })

  it('分别归一化 Anthropic 与 Gemini 顶层 system 和工具交互', () => {
    const anthropic = parseModelRequestConversationDetail(detail({ requestBody: {
      system: [{ type: 'text', text: 'Anthropic 系统' }],
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: '思考' }, { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { id: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '结果' }] },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    } }))
    expect(anthropic.messages[0]).toMatchObject({ kind: 'system', content: 'Anthropic 系统', path: ['system', '0'] })

    const gemini = parseModelRequestConversationDetail(detail({ requestBody: {
      systemInstruction: {
        parts: [
          { text: 'Gemini 系统一' },
          { text: 'Gemini 系统二' },
        ],
      },
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { id: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { value: '结果' } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }] }],
    } }))
    expect(gemini.messages.slice(0, 2).map(({ kind, content, path }) => ({ kind, content, path }))).toEqual([
      { kind: 'system', content: 'Gemini 系统一', path: ['systemInstruction', 'parts', '0'] },
      { kind: 'system', content: 'Gemini 系统二', path: ['systemInstruction', 'parts', '1'] },
    ])
    expect(gemini.messages.map(({ kind }) => kind)).toEqual(['system', 'system', 'assistant', 'tool-result'])
    expect(gemini.messages[2]?.toolCalls[0]).toMatchObject({ name: 'lookup' })
    expect(gemini.tools[0]).toMatchObject({ name: 'lookup', path: ['tools', '0', 'functionDeclarations', '0'] })
  })

  it('归一化 Responses input 和完整 SSE 响应证据', () => {
    const conversation = parseModelRequestConversationDetail(detail({
      requestBody: {
        input: [
          { role: 'user', content: '搜索新闻' },
          { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"q":"新闻"}' },
          { type: 'function_call_output', call_id: 'call-1', output: '新闻结果' },
        ],
      },
      responseBodyStatus: 'complete', responseBodyFormat: 'sse',
      responseBodyRaw: 'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\ndata: {"choices":[{"delta":{"content":"答案"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    }))

    expect(conversation.messages.map(({ kind }) => kind)).toEqual(['user', 'assistant', 'tool-result'])
    expect(conversation.messages[1]?.toolCalls[0]).toMatchObject({ id: 'call-1', name: 'search' })
    expect(conversation.messages[2]).toMatchObject({ toolCallId: 'call-1', content: '新闻结果' })
    expect(conversation.response).toMatchObject({ format: 'sse', reasoning: ['思考'], content: ['答案'], finishReasons: ['stop'] })
    expect(conversation.response?.raw).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'message' })]))
    expect(conversation.response?.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, source: 'response' })
  })

  it('归一化 AI SDK typed parts，并只把有证据的工具结果投影为独立消息', () => {
    const conversation = parseModelRequestConversationDetail(detail({ requestBody: {
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: '查询订单' },
            { type: 'file', mediaType: 'application/pdf', data: 'invoice-data' },
          ],
        },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '需要查询工具' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookupOrder', input: { id: 42 } },
          ],
        },
        {
          role: 'tool',
          parts: [
            { type: 'tool-result', toolCallId: 'call-1', toolName: 'lookupOrder', output: { type: 'json', value: { status: 'paid' } } },
          ],
        },
      ],
      tools: {
        lookupOrder: {
          description: '查询订单',
          inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        },
      },
    } }))

    expect(conversation.messages[0]).toMatchObject({
      kind: 'user',
      content: '查询订单',
      contentParts: [
        { kind: 'text', value: '查询订单' },
        { kind: 'file', value: 'invoice-data', mimeType: 'application/pdf' },
      ],
    })
    expect(conversation.messages[1]).toMatchObject({
      kind: 'assistant',
      reasoning: '需要查询工具',
      toolCalls: [{ id: 'call-1', name: 'lookupOrder', arguments: '{\n  "id": 42\n}' }],
    })
    expect(conversation.messages[2]).toMatchObject({
      kind: 'tool-result',
      toolCallId: 'call-1',
      content: '{\n  "status": "paid"\n}',
    })
    expect(conversation.tools[0]).toMatchObject({
      name: 'lookupOrder',
      description: '查询订单',
      parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      propertyCount: 1,
      requiredFields: ['id'],
      path: ['tools', 'lookupOrder'],
    })
  })

  it('AI SDK 同一消息内的工具结果保持 typed parts 原始顺序', () => {
    const conversation = parseModelRequestConversationDetail(detail({ requestBody: {
      messages: [{
        role: 'assistant',
        parts: [
          { type: 'text', text: '调用前' },
          { type: 'tool-result', toolCallId: 'call-2', toolName: 'lookup', output: { type: 'text', value: '工具结果' } },
          { type: 'text', text: '调用后' },
        ],
      }],
    } }))

    expect(conversation.messages.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: 'assistant', content: '调用前' },
      { kind: 'tool-result', content: '工具结果' },
      { kind: 'assistant', content: '调用后' },
    ])
    expect(conversation.messages[0]).toMatchObject({
      path: ['messages', '0', 'parts', '0'],
      raw: { type: 'text', text: '调用前' },
    })
    expect(conversation.messages[2]).toMatchObject({
      path: ['messages', '0', 'parts', '2'],
      raw: { type: 'text', text: '调用后' },
    })
  })

  it('保留多个 system 来源、多模态分片和跨字段工具声明的原始顺序', () => {
    const conversation = parseModelRequestConversationDetail(detail({ requestBody: {
      system_instruction: '第一条系统约束',
      system: [
        { type: 'text', text: '第二条系统约束' },
        { type: 'text', text: '第三条系统约束' },
      ],
      contents: [{
        role: 'user',
        parts: [
          { text: '识别图片' },
          { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
          { fileData: { mimeType: 'application/pdf', fileUri: 'https://example.com/a.pdf' } },
        ],
      }],
      functions: [{ name: 'legacy', parameters: { type: 'object' } }],
      tools: [{ functionDeclarations: [{ name: 'gemini', parameters: { type: 'object' } }] }],
    } }))

    expect(conversation.messages.slice(0, 3).map(({ kind, content, path }) => ({ kind, content, path }))).toEqual([
      { kind: 'system', content: '第一条系统约束', path: ['system_instruction'] },
      { kind: 'system', content: '第二条系统约束', path: ['system', '0'] },
      { kind: 'system', content: '第三条系统约束', path: ['system', '1'] },
    ])
    expect(conversation.messages[3]?.contentParts).toEqual([
      { kind: 'text', value: '识别图片' },
      { kind: 'image', value: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' },
      { kind: 'file', value: 'https://example.com/a.pdf', mimeType: 'application/pdf' },
    ])
    expect(conversation.tools.map(({ name, path }) => ({ name, path }))).toEqual([
      { name: 'legacy', path: ['functions', '0'] },
      { name: 'gemini', path: ['tools', '0', 'functionDeclarations', '0'] },
    ])
  })

  it('把纯文本响应作为本次模型正文，同时保留 TEXT 原始证据', () => {
    const response = parseModelRequestConversationDetail(detail({
      requestBody: { messages: [{ role: 'user', content: '你好' }] },
      responseBodyStatus: 'complete',
      responseBodyFormat: 'text',
      responseBodyRaw: '<b>原样文本，不执行 HTML</b>',
    })).response

    expect(response).toMatchObject({
      status: 'complete',
      format: 'text',
      content: ['<b>原样文本，不执行 HTML</b>'],
      raw: '<b>原样文本，不执行 HTML</b>',
    })
  })

  it('仅从响应中的显式证据归一化工具调用与工具结果', () => {
    const response = parseModelRequestConversationDetail(detail({
      requestBody: { input: '执行工具' },
      responseBodyStatus: 'complete',
      responseBodyFormat: 'json',
      responseBodyRaw: JSON.stringify({
        output: [
          { type: 'function_call', call_id: 'call-7', name: 'lookup', arguments: '{"id":7}' },
          { type: 'function_call_output', call_id: 'call-7', name: 'lookup', output: { ok: true } },
        ],
      }),
    })).response

    expect(response?.toolCalls).toEqual([{
      evidenceId: 'res:tool-call:output.0',
      id: 'call-7',
      name: 'lookup',
      arguments: '{"id":7}',
      characters: 8,
    }])
    expect(response?.toolResults).toEqual([{
      evidenceId: 'res:tool-result:output.1',
      id: 'call-7',
      name: 'lookup',
      content: '{\n  "ok": true\n}',
      characters: 16,
      path: ['output', '1'],
      raw: { type: 'function_call_output', call_id: 'call-7', name: 'lookup', output: { ok: true } },
    }])
  })

  it('SSE 重复快照只保留一条工具结果，且不扫描无关元数据', () => {
    const response = parseModelRequestConversationDetail(detail({
      requestBody: { input: '执行工具' },
      responseBodyStatus: 'complete',
      responseBodyFormat: 'sse',
      responseBodyRaw: [
        'data: {"output":[{"type":"function_call_output","call_id":"call-9","name":"lookup","output":{"ok":true}}],"metadata":{"type":"tool_result","content":"不是模型工具结果"}}',
        '',
        'data: {"output":[{"type":"function_call_output","call_id":"call-9","name":"lookup","output":{"ok":true}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    })).response

    expect(response?.toolResults).toEqual([
      expect.objectContaining({ id: 'call-9', name: 'lookup', content: '{\n  "ok": true\n}' }),
    ])
  })

  it('把 pending、不可用、采集错误和损坏 JSON 暴露为可渲染响应状态', () => {
    expect(parseModelRequestConversationDetail(detail({ responseBodyStatus: 'pending' })).response).toMatchObject({
      status: 'pending',
      statusMessage: '响应仍在采集中',
    })
    expect(parseModelRequestConversationDetail(detail({ responseBodyStatus: 'unavailable' })).response).toMatchObject({
      status: 'unavailable',
      statusMessage: '响应不可用',
    })
    expect(parseModelRequestConversationDetail(detail({ responseBodyStatus: 'error', responseBodyError: '读取响应失败' })).response).toMatchObject({
      status: 'error',
      statusMessage: '读取响应失败',
    })
    expect(parseModelRequestConversationDetail(detail({
      responseBodyStatus: 'complete',
      responseBodyFormat: 'json',
      responseBodyRaw: '{broken',
    })).response).toMatchObject({
      status: 'error',
      format: 'json',
      raw: '{broken',
      statusMessage: '响应 JSON 解析失败',
    })
  })

  it('未知请求结构返回明确解析状态而不生成猜测消息', () => {
    expect(parseModelRequestConversationDetail(detail({ requestBody: { temperature: 0.3 } }))).toMatchObject({
      messages: [], tools: [], parseError: '未识别请求体中的对话结构',
    })
  })
})
