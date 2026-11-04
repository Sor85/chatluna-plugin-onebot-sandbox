import { describe, expect, it } from 'vitest'
import { projectModelEvidence } from '../src/model-evidence'
import {
  aiSdkRequest,
  anthropicMessagesRequest,
  geminiGenerateContentRequest,
  openAiChatRequest,
  openAiResponsesRequest,
} from './fixtures/model-protocol-fixtures'

function paths(items: readonly { sources: readonly { path: readonly string[] }[] }[]) {
  return items.map(item => item.sources.map(source => source.path.join('.')))
}

describe('模型证据投影 · 请求消息平面', () => {
  it('把 OpenAI Chat Completions 请求投影为有序消息、工具调用与显式工具结果', () => {
    const { requestMessages, toolDefinitions, diagnostics } = projectModelEvidence({ requestBody: openAiChatRequest })

    expect(requestMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'system', text: '遵循系统提示' },
      { role: 'user', text: '查询天气' },
      { role: 'assistant', text: '正在查询' },
      { role: 'tool', text: '晴' },
    ])
    expect(paths(requestMessages)).toEqual([
      ['messages.0'],
      ['messages.1'],
      ['messages.2'],
      ['messages.3'],
    ])
    expect(requestMessages[2]?.toolCalls).toEqual([expect.objectContaining({
      name: 'lookup',
      callId: 'call-1',
      arguments: '{"city":"北京"}',
    })])
    expect(requestMessages[2]?.toolCalls[0]?.sources.map(({ path }) => path.join('.'))).toEqual(['messages.2.tool_calls.0'])
    expect(requestMessages[3]).toMatchObject({ toolCallId: 'call-1', toolName: 'lookup' })
    expect(toolDefinitions).toEqual([expect.objectContaining({
      name: 'lookup',
      description: '查询天气',
      propertyCount: 1,
      requiredFields: ['city'],
    })])
    expect(paths(toolDefinitions)).toEqual([['tools.0.function']])
    expect(diagnostics).toEqual([])
  })

  it('把 OpenAI Responses 的 instructions、input、function call 与 function call output 投影为独立证据', () => {
    const { requestMessages, toolDefinitions } = projectModelEvidence({ requestBody: openAiResponsesRequest })

    expect(requestMessages.map(({ role }) => role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(paths(requestMessages)).toEqual([
      ['instructions'],
      ['input.0'],
      ['input.1'],
      ['input.2'],
    ])
    expect(requestMessages[0]?.text).toBe('Responses 顶层指令')
    expect(requestMessages[2]?.toolCalls).toEqual([expect.objectContaining({ callId: 'call-2', name: 'search' })])
    expect(requestMessages[3]).toMatchObject({ role: 'tool', toolCallId: 'call-2', text: '新闻结果' })
    expect(paths(toolDefinitions)).toEqual([['tools.0']])
  })

  it('把 Anthropic Messages 的 System 分片、thinking、tool use 与 tool result 保持在原始边界', () => {
    const { requestMessages, toolDefinitions } = projectModelEvidence({ requestBody: anthropicMessagesRequest })

    expect(requestMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'system', text: 'Anthropic 系统一' },
      { role: 'system', text: 'Anthropic 系统二' },
      { role: 'assistant', text: '' },
      { role: 'tool', text: '结果' },
    ])
    expect(paths(requestMessages)).toEqual([
      ['system.0'],
      ['system.1'],
      ['messages.0'],
      ['messages.1.content.0'],
    ])
    expect(requestMessages[2]?.reasoning).toBe('先想一下')
    expect(requestMessages[2]?.toolCalls).toEqual([expect.objectContaining({ callId: 'tool-1', name: 'lookup' })])
    expect(requestMessages[3]?.toolCallId).toBe('tool-1')
    expect(paths(toolDefinitions)).toEqual([['tools.0']])
  })

  it('把 Gemini systemInstruction、contents、functionCall 与 functionResponse 投影为一致证据', () => {
    const { requestMessages, toolDefinitions } = projectModelEvidence({ requestBody: geminiGenerateContentRequest })

    expect(requestMessages.map(({ role }) => role)).toEqual(['system', 'system', 'user', 'assistant', 'tool'])
    expect(paths(requestMessages)).toEqual([
      ['systemInstruction.parts.0'],
      ['systemInstruction.parts.1'],
      ['contents.0'],
      ['contents.1'],
      ['contents.2.parts.0.functionResponse'],
    ])
    expect(requestMessages[2]?.contentParts).toEqual([
      { kind: 'text', value: '识别图片' },
      { kind: 'image', value: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' },
      { kind: 'file', value: 'https://example.com/a.pdf', mimeType: 'application/pdf' },
    ])
    expect(requestMessages[3]?.toolCalls).toEqual([expect.objectContaining({ name: 'lookup' })])
    expect(requestMessages[3]?.toolCalls[0]?.callId).toBeUndefined()
    expect(requestMessages[4]?.toolCallId).toBe('call-3')
    expect(paths(toolDefinitions)).toEqual([['tools.0.functionDeclarations.0']])
  })

  it('把 AI SDK typed parts 按原始顺序投影，并保留工具结果前后的语义分片', () => {
    const { requestMessages, toolDefinitions } = projectModelEvidence({ requestBody: aiSdkRequest })

    expect(requestMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: '查询订单' },
      { role: 'assistant', text: '' },
      { role: 'tool', text: '{\n  "status": "paid"\n}' },
    ])
    expect(requestMessages[0]?.contentParts).toEqual([
      { kind: 'text', value: '查询订单' },
      { kind: 'file', value: 'invoice-data', mimeType: 'application/pdf' },
    ])
    expect(requestMessages[1]).toMatchObject({
      reasoning: '需要查询工具',
      toolCalls: [expect.objectContaining({ callId: 'call-4', name: 'lookupOrder', arguments: '{\n  "id": 42\n}' })],
    })
    expect(requestMessages[2]?.toolCallId).toBe('call-4')
    expect(toolDefinitions).toEqual([expect.objectContaining({
      name: 'lookupOrder',
      description: '查询订单',
      propertyCount: 1,
      requiredFields: ['id'],
    })])
    expect(paths(toolDefinitions)).toEqual([['tools.lookupOrder']])
  })

  it('AI SDK 同一消息内的工具结果切断语义分片，不把前后文本合并', () => {
    const { requestMessages } = projectModelEvidence({
      requestBody: {
        messages: [{
          role: 'assistant',
          parts: [
            { type: 'text', text: '调用前' },
            { type: 'tool-result', toolCallId: 'call-5', toolName: 'lookup', output: { type: 'text', value: '工具结果' } },
            { type: 'text', text: '调用后' },
          ],
        }],
      },
    })

    expect(requestMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'assistant', text: '调用前' },
      { role: 'tool', text: '工具结果' },
      { role: 'assistant', text: '调用后' },
    ])
    expect(paths(requestMessages)).toEqual([
      ['messages.0.parts.0'],
      ['messages.0.parts.1'],
      ['messages.0.parts.2'],
    ])
  })

  it('多个顶层 System 来源保持独立边界，并按请求体字段顺序排列', () => {
    const { requestMessages } = projectModelEvidence({
      requestBody: {
        system_instruction: '第一条系统约束',
        system: [
          { type: 'text', text: '第二条系统约束' },
          { type: 'text', text: '第三条系统约束' },
        ],
        contents: [{ role: 'user', parts: [{ text: '正文' }] }],
      },
    })

    expect(requestMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'system', text: '第一条系统约束' },
      { role: 'system', text: '第二条系统约束' },
      { role: 'system', text: '第三条系统约束' },
      { role: 'user', text: '正文' },
    ])
    expect(paths(requestMessages)).toEqual([
      ['system_instruction'],
      ['system.0'],
      ['system.1'],
      ['contents.0'],
    ])
  })

  it('工具定义保持独立平面与跨字段原始声明顺序，不被投影为请求消息', () => {
    const { requestMessages, toolDefinitions } = projectModelEvidence({
      requestBody: {
        functions: [{ name: 'legacy', parameters: { type: 'object' } }],
        tools: [
          { functionDeclarations: [{ name: 'gemini', parameters: { type: 'object' } }] },
          { type: 'function', function: { name: 'duplicate' } },
          { type: 'function', function: { name: 'duplicate' } },
        ],
      },
    })

    expect(toolDefinitions.map(({ name }) => name)).toEqual(['legacy', 'gemini', 'duplicate', 'duplicate'])
    expect(paths(toolDefinitions)).toEqual([
      ['functions.0'],
      ['tools.0.functionDeclarations.0'],
      ['tools.1.function'],
      ['tools.2.function'],
    ])
    expect(new Set(toolDefinitions.map(({ evidenceId }) => evidenceId)).size).toBe(4)
    expect(requestMessages).toEqual([])
  })

  it('同时出现多个主要会话容器时按确定优先级选择并报告歧义，不静默拼接', () => {
    const { requestMessages, diagnostics } = projectModelEvidence({
      requestBody: {
        messages: [{ role: 'user', content: '来自 messages' }],
        contents: [{ role: 'user', parts: [{ text: '来自 contents' }] }],
        input: [{ role: 'user', content: '来自 input' }],
      },
    })

    expect(requestMessages.map(({ text }) => text)).toEqual(['来自 messages'])
    expect(diagnostics).toEqual([
      { code: 'request-container-ambiguous', severity: 'warning', source: expect.objectContaining({ region: 'request', path: ['contents'] }) },
      { code: 'request-container-ambiguous', severity: 'warning', source: expect.objectContaining({ region: 'request', path: ['input'] }) },
    ])
  })

  it('局部不支持只产生诊断，仍返回其他能够证明的请求证据', () => {
    const { requestMessages, toolDefinitions, diagnostics } = projectModelEvidence({
      requestBody: {
        temperature: 0.3,
        tools: [{ type: 'function', function: { name: 'still-here' } }],
      },
    })

    expect(requestMessages).toEqual([])
    expect(toolDefinitions.map(({ name }) => name)).toEqual(['still-here'])
    expect(diagnostics).toEqual([
      { code: 'request-body-unsupported', severity: 'warning', source: expect.objectContaining({ region: 'request', path: [] }) },
    ])
  })

  it('请求体不是对象时只返回结构化诊断', () => {
    expect(projectModelEvidence({ requestBody: '纯字符串' })).toMatchObject({
      requestMessages: [],
      toolDefinitions: [],
      diagnostics: [{ code: 'request-body-unsupported', severity: 'warning', source: { region: 'request', path: [], value: '纯字符串' } }],
    })
    expect(projectModelEvidence({}).diagnostics).toEqual([])
  })

  it('证据身份按区域、原始路径和语义种类确定，同一父节点内的不同语义项不冲突', () => {
    const body = {
      messages: [{ role: 'assistant', content: '文本', tool_calls: [{ id: 'a', function: { name: 'x' } }, { id: 'b', function: { name: 'x' } }] }],
    }
    const first = projectModelEvidence({ requestBody: body })
    const second = projectModelEvidence({ requestBody: structuredClone(body) })

    expect(first.requestMessages[0]?.evidenceId).toBe(second.requestMessages[0]?.evidenceId)
    const ids = [
      first.requestMessages[0]!.evidenceId,
      ...first.requestMessages[0]!.toolCalls.map(({ evidenceId }) => evidenceId),
    ]
    expect(new Set(ids).size).toBe(3)
  })

  it('缺少显式调用标识时不生成工具调用与工具结果的配对', () => {
    const { requestMessages } = projectModelEvidence({
      requestBody: {
        messages: [
          { role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: '{}' } }] },
          { role: 'tool', name: 'lookup', content: '结果' },
        ],
      },
    })

    expect(requestMessages[0]?.toolCalls[0]?.callId).toBeUndefined()
    expect(requestMessages[1]?.toolCallId).toBeUndefined()
    expect(requestMessages[1]?.toolName).toBe('lookup')
  })

  it('条目自身的 id 不会被当成显式调用标识', () => {
    const { requestMessages } = projectModelEvidence({
      requestBody: { messages: [{ role: 'tool', id: 'msg-1', name: 'lookup', content: '结果' }] },
    })
    expect(requestMessages[0]?.toolCallId).toBeUndefined()

    const responses = projectModelEvidence({
      requestBody: {
        input: [
          { type: 'function_call', id: 'item-1', name: 'search', arguments: '{}' },
          { type: 'function_call_output', id: 'item-2', output: '结果' },
        ],
      },
    })
    expect(responses.requestMessages[0]?.toolCalls[0]?.callId).toBeUndefined()
    expect(responses.requestMessages[1]?.toolCallId).toBeUndefined()
  })

  it('工具调用对象自身的 id 仍然是显式调用标识', () => {
    const openAi = projectModelEvidence({
      requestBody: { messages: [{ role: 'assistant', tool_calls: [{ id: 'call-9', function: { name: 'x' } }] }] },
    })
    expect(openAi.requestMessages[0]?.toolCalls[0]?.callId).toBe('call-9')

    const anthropic = projectModelEvidence({
      requestBody: { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-9', name: 'x', input: {} }] }] },
    })
    expect(anthropic.requestMessages[0]?.toolCalls[0]?.callId).toBe('tool-9')
  })

  it('Responses 的 input 是单个条目对象时按原始路径投影为一条证据', () => {
    const { requestMessages } = projectModelEvidence({
      requestBody: { instructions: '顶层指令', input: { role: 'user', content: '单条输入' } },
    })

    expect(requestMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'system', text: '顶层指令' },
      { role: 'user', text: '单条输入' },
    ])
    expect(paths(requestMessages)).toEqual([['instructions'], ['input']])
  })

  it('被工具结果切断的语义分片为每个原始分块各留一条真实来源', () => {
    const first = { type: 'text', text: '一' }
    const second = { type: 'text', text: '二' }
    const result = { type: 'tool_result', tool_use_id: 't1', content: '结果' }
    const third = { type: 'text', text: '三' }
    const { requestMessages } = projectModelEvidence({
      requestBody: { messages: [{ role: 'user', content: [first, second, result, third] }] },
    })

    expect(requestMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: '一\n二' },
      { role: 'tool', text: '结果' },
      { role: 'user', text: '三' },
    ])
    expect(paths(requestMessages)).toEqual([
      ['messages.0.content.0', 'messages.0.content.1'],
      ['messages.0.content.2'],
      ['messages.0.content.3'],
    ])
    // 分片来源必须是原始分块的只读引用，而不是为分片新建的数组。
    expect(requestMessages[0]?.sources[0]?.value).toBe(first)
    expect(requestMessages[0]?.sources[1]?.value).toBe(second)
  })

  it('消息级 tool_calls 被工具结果切断时来源指向整条原始消息', () => {
    const message = {
      role: 'assistant',
      tool_calls: [{ id: 'call-6', function: { name: 'lookup', arguments: '{}' } }],
      content: [{ type: 'tool_result', tool_use_id: 'call-6', content: '结果' }],
    }
    const { requestMessages } = projectModelEvidence({ requestBody: { messages: [message] } })

    expect(requestMessages.map(({ role }) => role)).toEqual(['assistant', 'tool'])
    expect(paths(requestMessages)).toEqual([['messages.0'], ['messages.0.content.0']])
    expect(requestMessages[0]?.sources[0]?.value).toBe(message)
    expect(requestMessages[0]?.toolCalls[0]?.callId).toBe('call-6')
  })

  it('投影持有原始子树的引用而不是深拷贝', () => {
    const message = { role: 'user' as const, content: '引用检查' }
    const { requestMessages } = projectModelEvidence({ requestBody: { messages: [message] } })

    expect(requestMessages[0]?.sources[0]?.value).toBe(message)
  })
})
