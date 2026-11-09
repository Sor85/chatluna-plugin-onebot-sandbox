import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { SandboxMcpService } from '../src/mcp/service'
import {
  LARGE_BASE64_CHAR_THRESHOLD,
  SandboxOneBotDebugStore,
} from '../src/onebot-debug'
import { MemoryOneBotDebugPersistence } from '../src/persistence'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

function pngBase64(minChars = LARGE_BASE64_CHAR_THRESHOLD + 64): string {
  // PNG 魔数 + 填充，确保 MIME 推断为 image/png，并超过折叠阈值。
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const fill = Buffer.alloc(Math.ceil(minChars * 3 / 4) - header.length, 0x41)
  return Buffer.concat([header, fill]).toString('base64')
}

function longPlainText(minChars = LARGE_BASE64_CHAR_THRESHOLD + 32): string {
  // 含空格与中文，避免被误判为 Base64。
  return `普通长文本，不是 Base64：${'测 '.repeat(Math.ceil(minChars / 2))}`.slice(0, minChars + 16)
}

describe('折叠调试记录中的大型值', () => {
  it('按内容识别嵌套 Base64/data-url/base64:// 并生成摘要，列表永不展开', async () => {
    const store = new SandboxOneBotDebugStore({ maxRecords: 100, maxBytes: 50 * 1024 * 1024 })
    const body = pngBase64()
    const dataUrl = `data:image/png;base64,${body}`
    const prefixed = `base64://${body}`
    const nested = {
      file: body,
      nested: {
        image: dataUrl,
        sticker: prefixed,
        items: [{ blob: body }],
      },
      note: longPlainText(),
    }

    const projected = store.append({
      botId: '20001',
      implementation: 'napcat',
      direction: 'action',
      requestedAction: 'upload_group_file',
      action: 'upload_group_file',
      status: 'success',
      durationMs: 3,
      payload: nested,
      result: { ok: true, data: body },
    })

    const expectedSha = createHash('sha256').update(body).digest('hex')
    const expectedByteLength = Math.floor(body.length * 3 / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
    const summary = {
      kind: 'large-value',
      encoding: 'base64',
      mimeType: 'image/png',
      charCount: body.length,
      byteLength: expectedByteLength,
      sha256: expectedSha,
    }

    expect(projected.payload).toEqual({
      file: summary,
      nested: {
        image: {
          kind: 'large-value',
          encoding: 'data-url',
          mimeType: 'image/png',
          charCount: body.length,
          byteLength: expectedByteLength,
          sha256: expectedSha,
        },
        sticker: summary,
        items: [{ blob: summary }],
      },
      note: nested.note,
    })
    expect(projected.result).toEqual({ ok: true, data: summary })
    expect(JSON.stringify(projected)).not.toContain(body.slice(0, 64))

    const page = (await store.getRecords({ limit: 10 }))
    expect(page.records[0]?.payload).toEqual(projected.payload)
    expect(page.capacity.recordCount).toBe(1)
    expect(page.capacity.totalBytes).toBeGreaterThan(body.length)

    const expanded = (await store.getRecord(projected.id, true))
    expect(expanded?.payload).toEqual(nested)
    expect(expanded?.result).toEqual({ ok: true, data: body })
    expect((await store.getRecord(projected.id, false))?.payload).toEqual(projected.payload)
  })

  it('容量按完整持久化内容统计，折叠投影不影响 totalBytes', async () => {
    const persistence = new MemoryOneBotDebugPersistence('fold-capacity')
    const store = new SandboxOneBotDebugStore({
      maxRecords: 100,
      maxBytes: 50 * 1024 * 1024,
      persistence,
    })
    await store.waitForReady()
    const body = pngBase64(16 * 1024)
    const projected = store.append({
      botId: '20001',
      implementation: 'napcat',
      direction: 'action',
      requestedAction: 'set_qq_avatar',
      action: 'set_qq_avatar',
      status: 'success',
      durationMs: 1,
      payload: { file: body },
    })
    await store.waitForPersistence()

    const page = (await store.getRecords())
    expect(JSON.stringify(page.records[0]?.payload)).not.toContain(body.slice(0, 32))
    expect(page.capacity.totalBytes).toBeGreaterThan(body.length)
    // 持久化保留完整原始值。
    const reloaded = new SandboxOneBotDebugStore({ persistence })
    await reloaded.waitForReady()
    const full = (await reloaded.getRecord(projected.id, true))
    expect(full?.payload).toEqual({ file: body })
    expect((await reloaded.getCapacity()).totalBytes).toBe(page.capacity.totalBytes)
  })

  it('非 Base64 长文本不被误折叠，消息正文逐字保留', async () => {
    const store = new SandboxOneBotDebugStore()
    const text = longPlainText()
    const projected = store.append({
      botId: '20001',
      implementation: 'napcat',
      direction: 'event',
      requestedAction: 'message.private',
      action: 'message.private',
      status: 'success',
      durationMs: 1,
      payload: {
        raw_message: text,
        description: text,
        // 凭证类键仍然脱敏；正文保留不等于全量透出。
        access_token: 'secret-token',
      },
    })
    expect(projected.payload).toEqual({
      raw_message: text,
      description: text,
      access_token: '[已脱敏]',
    })
    expect(JSON.stringify(projected.payload)).not.toContain('"kind":"large-value"')
  })
})

describe('MCP 折叠大型调试值', () => {
  it('列表禁止 includeLargeValues，单条可显式展开；wait 始终折叠', async () => {
    const app = new App()
    runningApps.push(app)
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-fold-'))
    const control = new SandboxControlService(app)
    const service = new SandboxMcpService(app, control, { dataDirectory: directory })
    const credential = service.createCredential('调试凭证', ['debug', 'read'])
    const body = pngBase64()

    const cursor = service.currentCursor()
    const projected = control.recordOneBotDebug({
      botId: '20001',
      implementation: 'napcat',
      direction: 'action',
      requestedAction: 'set_qq_avatar',
      action: 'set_qq_avatar',
      status: 'success',
      durationMs: 2,
      payload: { file: body, nested: { data: `data:image/png;base64,${body}` } },
      result: { status: 'ok', data: body },
    })

    await expect(service.callTool(credential.token, 'list_onebot_debug_records', {
      includeLargeValues: true,
    })).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringContaining('includeLargeValues'),
    })

    const page = await service.callTool(credential.token, 'list_onebot_debug_records', {
      limit: 5,
    }) as {
      items: Array<{ id: string, payload: unknown, result: unknown }>
      capacity: { totalBytes: number, recordCount: number }
    }
    expect(page.items[0]?.id).toBe(projected.id)
    expect(page.items[0]?.payload).toEqual(expect.objectContaining({
      file: expect.objectContaining({ kind: 'large-value', encoding: 'base64', mimeType: 'image/png' }),
    }))
    expect(JSON.stringify(page.items[0])).not.toContain(body.slice(0, 48))
    expect(page.capacity.recordCount).toBe(1)
    expect(page.capacity.totalBytes).toBeGreaterThan(body.length)

    const folded = await service.callTool(credential.token, 'get_onebot_debug_record', {
      recordId: projected.id,
    }) as { payload: unknown }
    expect(folded.payload).toEqual(page.items[0]?.payload)

    const expanded = await service.callTool(credential.token, 'get_onebot_debug_record', {
      recordId: projected.id,
      includeLargeValues: true,
    }) as { payload: { file: string }, result: { data: string } }
    expect(expanded.payload.file).toBe(body)
    expect(expanded.result.data).toBe(body)

    await expect(service.callTool(credential.token, 'wait_for_onebot_action', {
      cursor,
      action: 'set_qq_avatar',
      timeoutSeconds: 1,
    })).resolves.toMatchObject({
      outcome: 'matched',
      record: {
        id: projected.id,
        payload: expect.objectContaining({
          file: expect.objectContaining({ kind: 'large-value' }),
        }),
      },
    })
  })
})

describe('控制服务与 Console 单条详情', () => {
  it('调试记录库的 requireRecord 支持 includeLargeValues，Console 异步暴露 debug-record', async () => {
    const app = new App()
    runningApps.push(app)
    const control = new SandboxControlService(app)
    const body = pngBase64()
    const projected = control.recordOneBotDebug({
      botId: '20001',
      implementation: 'napcat',
      direction: 'action',
      requestedAction: 'upload_private_file',
      action: 'upload_private_file',
      status: 'success',
      durationMs: 1,
      payload: { file: body },
    })

    expect((await control.getOneBotDebugStore().requireRecord(projected.id)).payload).toEqual({
      file: expect.objectContaining({ kind: 'large-value', mimeType: 'image/png' }),
    })
    expect((await control.getOneBotDebugStore().requireRecord(projected.id, true)).payload).toEqual({ file: body })

    const { registerConsole } = await import('../src/console')
    const listeners = new Map<string, (...args: any[]) => any>()
    registerConsole({
      addEntry() {},
      addListener(event, callback) { listeners.set(event, callback as never) },
      broadcast() {},
    }, control, {
      sandboxTimBubbleTail: true,
      sandboxIncomingBubbleStyle: 'shadow',
      sandboxAccentColor: '#2563eb',
      sandboxMarkRecalledMessages: true,
    })

    const getRecord = listeners.get('onebot-sandbox.debug-record')
    expect(getRecord).toBeTypeOf('function')
    expect(await getRecord?.({ recordId: projected.id })).toMatchObject({
      id: projected.id,
      payload: { file: expect.objectContaining({ kind: 'large-value' }) },
      source: { type: 'main', name: '主环境' },
    })
    expect(await getRecord?.({ recordId: projected.id, includeLargeValues: true })).toMatchObject({
      payload: { file: body },
    })
    expect(await listeners.get('onebot-sandbox.debug-records')?.({})).toMatchObject({
      capacity: expect.objectContaining({ recordCount: 1, totalBytes: expect.any(Number) }),
    })
  })
})
