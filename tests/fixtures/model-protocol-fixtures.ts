/**
 * 集中模型协议 fixture 矩阵。
 *
 * 同一份协议事实只在这里编码一次，模型证据投影测试和下游轨迹 / 对话视图测试共用，
 * 避免同一个协议结构在多个测试套件里各写一遍再各自漂移。
 */

export const openAiChatRequest = {
  model: 'gpt-4.1',
  messages: [
    { role: 'system', content: '遵循系统提示' },
    { role: 'user', content: '查询天气' },
    { role: 'assistant', content: '正在查询', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', name: 'lookup', content: '晴' },
  ],
  tools: [{ type: 'function', function: { name: 'lookup', description: '查询天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
}

export const openAiResponsesRequest = {
  model: 'gpt-5',
  instructions: 'Responses 顶层指令',
  input: [
    { role: 'user', content: '搜索新闻' },
    { type: 'function_call', call_id: 'call-2', name: 'search', arguments: '{"q":"新闻"}' },
    { type: 'function_call_output', call_id: 'call-2', output: '新闻结果' },
  ],
  tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
}

export const anthropicMessagesRequest = {
  model: 'claude-sonnet-4',
  system: [
    { type: 'text', text: 'Anthropic 系统一' },
    { type: 'text', text: 'Anthropic 系统二' },
  ],
  messages: [
    { role: 'assistant', content: [{ type: 'thinking', thinking: '先想一下' }, { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { id: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '结果' }] },
  ],
  tools: [{ name: 'lookup', description: '查询', input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } }],
}

export const geminiGenerateContentRequest = {
  systemInstruction: {
    parts: [
      { text: 'Gemini 系统一' },
      { text: 'Gemini 系统二' },
    ],
  },
  contents: [
    {
      role: 'user',
      parts: [
        { text: '识别图片' },
        { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
        { fileData: { mimeType: 'application/pdf', fileUri: 'https://example.com/a.pdf' } },
      ],
    },
    { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { city: '北京' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call-3', name: 'lookup', response: { weather: '晴' } } }] },
  ],
  tools: [{ functionDeclarations: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }] }],
}

export const aiSdkRequest = {
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
        { type: 'tool-call', toolCallId: 'call-4', toolName: 'lookupOrder', input: { id: 42 } },
      ],
    },
    {
      role: 'tool',
      parts: [
        { type: 'tool-result', toolCallId: 'call-4', toolName: 'lookupOrder', output: { type: 'json', value: { status: 'paid' } } },
      ],
    },
  ],
  tools: {
    lookupOrder: {
      description: '查询订单',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
  },
}

/** 旧式 function 声明：工具定义写在顶层 functions 数组里，没有 tools 字段。 */
export const legacyFunctionsRequest = {
  model: 'gpt-3.5-turbo-0613',
  messages: [
    { role: 'system', content: '旧式系统提示' },
    { role: 'user', content: '北京天气' },
  ],
  functions: [
    { name: 'get_weather', description: '查询天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    { name: 'get_time', description: '查询时间', parameters: { type: 'object' } },
  ],
  function_call: 'auto',
}

export const openAiChatJsonResponse = JSON.stringify({
  choices: [{
    message: {
      content: '北京今天晴朗',
      reasoning_content: '读取工具结果',
      tool_calls: [{ id: 'call-9', function: { name: 'forecast', arguments: '{"city":"北京"}' } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 20, completion_tokens: 8 },
})

export const openAiChatSseResponse = [
  'data: {"choices":[{"delta":{"reasoning_content":"思"}}]}',
  '',
  'data: {"choices":[{"delta":{"reasoning_content":"考"}}]}',
  '',
  'data: {"choices":[{"delta":{"content":"北"}}]}',
  '',
  'data: {"choices":[{"delta":{"content":"京晴"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
  '',
  'data: [DONE]',
  '',
].join('\n')

export const anthropicMessagesJsonResponse = JSON.stringify({
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: '推理内容' },
    { type: 'text', text: 'Anthropic 正文' },
    { type: 'tool_use', id: 'tool-9', name: 'lookup', input: { id: 2 } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
})

export const geminiCandidatesJsonResponse = JSON.stringify({
  candidates: [{
    content: {
      parts: [
        { text: '思考片段', thought: true },
        { text: 'Gemini 正文' },
        { functionCall: { name: 'lookup', args: { city: '北京' } } },
      ],
    },
    finishReason: 'STOP',
  }],
  usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 6, thoughtsTokenCount: 2 },
})

export const openAiResponsesJsonResponse = JSON.stringify({
  object: 'response',
  output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Responses 推理' }] },
    { type: 'message', content: [{ type: 'output_text', text: 'Responses 正文' }] },
    { type: 'function_call', call_id: 'call-7', name: 'lookup', arguments: '{"id":7}' },
    { type: 'function_call_output', call_id: 'call-7', name: 'lookup', output: { ok: true } },
  ],
  usage: { input_tokens: 5, output_tokens: 3 },
})
