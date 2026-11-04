import { describe, expect, it } from 'vitest'
import {
  SandboxModelRequestStore,
  createModelRequestError,
} from '../src/model-request'
import { SandboxDomainError, SandboxModelRequestCursorExpiredError, type SandboxPresetRuntimeSnapshot } from '../src/types'
import {
  aiSdkRequest,
  anthropicMessagesRequest,
  geminiGenerateContentRequest,
  legacyFunctionsRequest,
  openAiChatRequest,
  openAiResponsesRequest,
} from './fixtures/model-protocol-fixtures'

const presetSnapshot: SandboxPresetRuntimeSnapshot = {
  kind: 'core',
  presetName: 'demo',
  capturedAt: '2026-01-01T00:00:00.000Z',
  source: 'prompts:\n  - role: system\n    content: Hello {name}.\n',
  templates: [{ path: ['prompts', 0, 'content'], role: 'system', template: 'Hello {name}.' }],
}

function appendRecord(
  store: SandboxModelRequestStore,
  overrides: Partial<Parameters<SandboxModelRequestStore['append']>[0]> = {},
) {
  return store.append({
    status: 'success',
    durationMs: 12,
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    provider: 'openai',
    model: 'gpt-4o',
    attribution: 'attributed',
    entities: { scopeId: 'main', botId: '20001', conversationId: 'private:10001:20001' },
    requestBodyAvailable: true,
    requestBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }] },
    responseBodyStatus: 'complete',
    responseBodyFormat: 'json',
    responseStatus: 200,
    responseBodyRaw: JSON.stringify({ choices: [{ message: { content: 'hello' } }] }),
    ...overrides,
  })
}

describe('模型请求记录库', () => {
  it('列表省略请求体与协议派生计数，详情保留完整请求体并给出证据计数', async () => {
    const store = new SandboxModelRequestStore()
    const created = appendRecord(store)
    const page = (await store.getRecords())
    expect(page.records).toHaveLength(1)
    expect(page.records[0]).not.toHaveProperty('requestBody')
    expect(page.records[0]).not.toHaveProperty('responseBodyRaw')
    expect(page.records[0]).not.toHaveProperty('requestBodyKeyCount')
    expect(page.records[0]).not.toHaveProperty('evidenceCounts')
    expect(page.records[0]).toMatchObject({
      id: created.id,
      status: 'success',
      model: 'gpt-4o',
    })
    expect((await store.getRecord(created.id))).toMatchObject({
      id: created.id,
      requestBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      responseBodyStatus: 'complete',
      responseBodyFormat: 'json',
      responseStatus: 200,
      responseBodyRaw: JSON.stringify({ choices: [{ message: { content: 'hello' } }] }),
      requestBodyKeyCount: 3,
      evidenceCounts: { requestMessageCount: 1, toolDefinitionCount: 1 },
    })
  })

  it('列表只暴露预设快照摘要，详情保留模板源码并派生预设变量', async () => {
    const store = new SandboxModelRequestStore()
    const created = appendRecord(store, {
      presetSnapshots: [presetSnapshot],
      requestBody: { model: 'gpt-4o', messages: [{ role: 'system', content: 'Hello Alice.' }] },
    })

    expect((await store.getRecords()).records[0]).toMatchObject({
      presetSnapshotSummaries: [{ kind: 'core', presetName: 'demo', templateCount: 1, capturedAt: presetSnapshot.capturedAt }],
    })
    expect(JSON.stringify((await store.getRecords()).records[0])).not.toContain('Hello {name}')
    expect((await store.getRecord(created.id))?.presetSnapshots).toEqual([presetSnapshot])
    expect((await store.getRecord(created.id))?.variables).toEqual([
      expect.objectContaining({ name: 'name', status: 'observed', value: 'Alice' }),
    ])
    expect((await store.getRawRecords())[0]?.presetSnapshots).toEqual([presetSnapshot])
  })

  it('没有运行时预设快照的记录照常返回详情，变量为空', async () => {
    const store = new SandboxModelRequestStore()
    const created = appendRecord(store)
    expect((await store.getRecord(created.id))?.variables).toEqual([])
  })

  it('没有采集到请求体时不产生字段数与证据计数', async () => {
    const store = new SandboxModelRequestStore()
    const created = appendRecord(store, {
      requestBodyAvailable: false,
      requestBody: undefined,
      presetSnapshots: [presetSnapshot],
    })
    const detail = (await store.getRecord(created.id))!

    expect(detail).not.toHaveProperty('requestBodyKeyCount')
    expect(detail).not.toHaveProperty('evidenceCounts')
    expect(detail.requestBodyAvailable).toBe(false)
    expect(detail.variables).toEqual([])
  })

  it('采集到的请求体不是对象时证据计数取零，字段数仍然缺省', async () => {
    const store = new SandboxModelRequestStore()
    for (const requestBody of ['纯文本请求体', [{ role: 'user', content: 'hi' }], 42] as const) {
      const created = appendRecord(store, { requestBody })
      const detail = (await store.getRecord(created.id))!

      expect(detail).not.toHaveProperty('requestBodyKeyCount')
      expect(detail.evidenceCounts, JSON.stringify(requestBody)).toEqual({ requestMessageCount: 0, toolDefinitionCount: 0 })
    }
  })

  it('按 Gemini generateContent 结构统计请求消息和展平后的函数声明工具', async () => {
    const store = new SandboxModelRequestStore()
    const created = appendRecord(store, {
      url: 'http://192.168.5.3/v1beta/models/gemini:generateContent',
      provider: '192.168.5.3',
      model: undefined,
      requestBody: {
        contents: [{ role: 'user', parts: [{ text: '你好' }] }],
        safetySettings: [],
        generationConfig: {},
        systemInstruction: { role: 'user', parts: [{ text: '系统提示' }] },
        tools: [{ functionDeclarations: [
          { name: 'music_voice' },
          { name: 'jmcomic_search' },
        ] }],
      },
    })

    expect((await store.getRecord(created.id))).toMatchObject({
      requestBodyKeyCount: 5,
      evidenceCounts: { requestMessageCount: 2, toolDefinitionCount: 2 },
    })
  })

  it('同一条记录从 pending 更新为 success 或 error，不新增序号', async () => {
    const store = new SandboxModelRequestStore()
    const pending = appendRecord(store, {
      status: 'pending',
      durationMs: 0,
      responseBodyStatus: 'pending',
      responseBodyRaw: undefined,
    })
    const success = await store.update(pending.id, {
      status: 'success',
      durationMs: 40,
      responseBodyStatus: 'complete',
      responseBodyFormat: 'text',
      responseStatus: 200,
      responseBodyRaw: 'done',
    })
    expect(success).toMatchObject({
      id: pending.id,
      sequence: pending.sequence,
      status: 'success',
      durationMs: 40,
      responseBodyStatus: 'complete',
      responseBodyRaw: 'done',
    })
    expect((await store.getRecords()).records).toHaveLength(1)

    const failed = appendRecord(store, { status: 'pending', durationMs: 0, model: 'gpt-4.1' })
    await store.update(failed.id, { status: 'error', durationMs: 8, error: createModelRequestError(new Error('timeout')) })
    expect((await store.getRecord(failed.id))).toMatchObject({
      status: 'error',
      error: { code: 'transient_error', retryable: true, message: 'timeout' },
    })
    expect((await store.getRecords({ status: 'error' })).records.map(({ id }) => id)).toEqual([failed.id])
  })

  it('按稳定序号新到旧分页，回收后的游标返回 cursor_expired', async () => {
    const store = new SandboxModelRequestStore({ maxRecords: 2 })
    appendRecord(store, { model: 'one' })
    appendRecord(store, { model: 'two' })
    appendRecord(store, { model: 'three' })
    const page = (await store.getRecords({ limit: 1 }))
    expect(page.records.map(({ model }) => model)).toEqual(['three'])
    expect(page.hasMore).toBe(true)
    expect((await store.getRecords({ limit: 1, beforeSequence: page.nextCursor })).records.map(({ model }) => model)).toEqual(['two'])
    await expect(store.getRecords({ beforeSequence: 1 })).rejects.toThrow(SandboxModelRequestCursorExpiredError)
  })

  it('支持按创建时间和记录 ID 做跨库分页游标', async () => {
    const store = new SandboxModelRequestStore()
    const created = appendRecord(store, { model: 'one' })
    expect((await store.getRecords({ beforeCreatedAt: '1970-01-01T00:00:00.000Z' })).records).toEqual([])
    expect((await store.getRecords({ beforeCreatedAt: created.createdAt, beforeId: created.id })).records).toEqual([])
    expect((await store.getRecords({ beforeCreatedAt: '2999-01-01T00:00:00.000Z' })).records.map(({ id }) => id)).toEqual([created.id])
  })

  it('支持按时间正序返回记录', async () => {
    const store = new SandboxModelRequestStore()
    appendRecord(store, { model: 'one' })
    appendRecord(store, { model: 'two' })
    expect((await store.getRecords({ order: 'asc' })).records.map(({ model }) => model)).toEqual(['one', 'two'])
    expect((await store.getRecords({ order: 'desc' })).records.map(({ model }) => model)).toEqual(['two', 'one'])
  })

  /**
   * 「这条记录在不在」由记录库判定。两种读取并存而不是互相替代：跨记录域遍历要靠返回空值
   * 区分「这个域里没有」与「这个域坏了」，因此不能只留抛出的那一个。
   */
  it('取不到返回空值与取不到就抛并存，抛的是领域错误且消息含记录标识', async () => {
    const store = new SandboxModelRequestStore()
    appendRecord(store, { model: 'one' })

    expect(await store.getRecord('不存在的记录')).toBeUndefined()
    await expect(store.requireRecord('不存在的记录')).rejects.toThrow(SandboxDomainError)
    await expect(store.requireRecord('不存在的记录')).rejects.toThrow('模型请求记录不存在：不存在的记录')
  })
})

/**
 * 协议形状回归表。
 *
 * 期望值逐 fixture 硬编码：不与共享模型证据投影的数组长度作比较，否则断言与实现同源，
 * 投影本身回退时会跟着一起错。这张表是"概览格计数与模型请求对话视图同源"的全部证据。
 */
describe('模型请求详情的协议形状计数', () => {
  const SHAPES: readonly { name: string, requestBody: unknown, keyCount: number, requestMessageCount: number, toolDefinitionCount: number }[] = [
    { name: 'OpenAI Chat Completions', requestBody: openAiChatRequest, keyCount: 3, requestMessageCount: 4, toolDefinitionCount: 1 },
    { name: 'OpenAI Responses', requestBody: openAiResponsesRequest, keyCount: 4, requestMessageCount: 4, toolDefinitionCount: 1 },
    { name: 'Anthropic Messages', requestBody: anthropicMessagesRequest, keyCount: 4, requestMessageCount: 4, toolDefinitionCount: 1 },
    { name: 'Gemini generateContent', requestBody: geminiGenerateContentRequest, keyCount: 3, requestMessageCount: 5, toolDefinitionCount: 1 },
    { name: 'AI SDK', requestBody: aiSdkRequest, keyCount: 2, requestMessageCount: 3, toolDefinitionCount: 1 },
    { name: '旧式 function 声明', requestBody: legacyFunctionsRequest, keyCount: 4, requestMessageCount: 2, toolDefinitionCount: 2 },
  ]

  for (const shape of SHAPES) {
    it(`${shape.name} 的请求消息数与工具定义数与共享模型证据投影一致`, async () => {
      const store = new SandboxModelRequestStore()
      const created = appendRecord(store, { requestBody: shape.requestBody })

      expect((await store.getRecord(created.id))).toMatchObject({
        requestBodyKeyCount: shape.keyCount,
        evidenceCounts: {
          requestMessageCount: shape.requestMessageCount,
          toolDefinitionCount: shape.toolDefinitionCount,
        },
      })
    })
  }
})
