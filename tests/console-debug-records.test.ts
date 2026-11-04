import { App } from './helpers/app'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxTestSpaceService } from '../src/test-spaces'
import type { SandboxAppearance } from '../src/types'
import { SandboxDomainError } from '../src/types'

const appearance: SandboxAppearance = {
  enableSandboxFrostedGlass: true,
  sandboxTimBubbleTail: true,
  sandboxColorMode: 'auto',
  sandboxAccentColor: '#2563eb',
  sandboxMarkRecalledMessages: true,
}

const runningApps: App[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

describe('OneBot 调试 Console 协议', () => {
  it('只暴露筛选查询和清理，不提供记录重放入口', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')
    await control.bot.internal._request('get_login_info', {})

    const listeners = new Map<string, unknown>()
    const consoleRegistrar: SandboxConsoleRegistrar = {
      addEntry() {},
      addListener(event, callback) {
        listeners.set(event, callback)
      },
      broadcast() {},
    }
    registerConsole(consoleRegistrar, control, appearance)

    const listRecords = listeners.get('onebot-sandbox.debug-records')
    const getRecord = listeners.get('onebot-sandbox.debug-record')
    const clearRecords = listeners.get('onebot-sandbox.clear-debug-records')
    expect(listRecords).toBeTypeOf('function')
    expect(getRecord).toBeTypeOf('function')
    expect(clearRecords).toBeTypeOf('function')
    if (typeof listRecords !== 'function' || typeof getRecord !== 'function' || typeof clearRecords !== 'function') {
      throw new Error('调试记录监听器未注册')
    }
    expect(listeners.has('onebot-sandbox.replay-debug-record')).toBe(false)
    const page = await Reflect.apply(listRecords, undefined, [{ direction: 'action', action: 'get_login_info' }]) as {
      records: Array<{ id: string, requestedAction: string }>
      hasMore: boolean
      capacity: { recordCount: number }
    }
    expect(page).toMatchObject({
      records: [expect.objectContaining({ requestedAction: 'get_login_info', action: 'get_login_info', status: 'success' })],
      hasMore: false,
      capacity: expect.objectContaining({ recordCount: 1 }),
    })
    expect(await Reflect.apply(getRecord, undefined, [{ recordId: page.records[0]!.id }])).toMatchObject({
      id: page.records[0]!.id,
      requestedAction: 'get_login_info',
      source: { type: 'main', name: '主环境' },
    })
    expect(await Reflect.apply(clearRecords, undefined, [])).toEqual({ cleared: 1 })
    expect(await Reflect.apply(listRecords, undefined, [{}])).toMatchObject({ records: [], hasMore: false })
  })

  it('在主环境汇总并清理所有测试空间调试记录，同时保留显式空间读取', async () => {
    vi.useFakeTimers()
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { runtimeBots })
    const spaces = new SandboxTestSpaceService(app, runtimeBots)
    const first = spaces.createSpace({ name: '空间 A' })
    const listeners = new Map<string, (...args: any[]) => any>()
    const registrar: SandboxConsoleRegistrar = {
      addEntry() {},
      addListener(event, callback) { listeners.set(event, callback as never) },
      broadcast() {},
    }
    registerConsole(registrar, control, appearance, undefined, spaces)

    vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'))
    control.recordOneBotDebug({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'main-action', action: 'main-action',
      status: 'success', durationMs: 1,
    })
    vi.setSystemTime(new Date('2026-07-30T10:00:01.000Z'))
    first.control.recordOneBotDebug({
      botId: '21001', implementation: 'llbot', direction: 'event',
      requestedAction: 'space-event', action: 'space-event',
      status: 'success', durationMs: 2,
    })

    expect(await listeners.get('onebot-sandbox.debug-records')?.({})).toMatchObject({
      records: [
        { requestedAction: 'space-event', source: { type: 'test-space', spaceId: first.id, name: '空间 A' } },
        { requestedAction: 'main-action', source: { type: 'main', name: '主环境' } },
      ],
    })
    expect(await listeners.get('onebot-sandbox.debug-records')?.({ order: 'asc' })).toMatchObject({
      records: [
        { requestedAction: 'main-action', source: { type: 'main', name: '主环境' } },
        { requestedAction: 'space-event', source: { type: 'test-space', spaceId: first.id, name: '空间 A' } },
      ],
    })
    expect(await listeners.get('onebot-sandbox.debug-records')?.({ spaceId: first.id })).toMatchObject({
      records: [
        { requestedAction: 'space-event', source: { type: 'test-space', spaceId: first.id, name: '空间 A' } },
      ],
    })
    expect(await listeners.get('onebot-sandbox.clear-debug-records')?.({})).toEqual({ cleared: 2 })
    expect(await control.getOneBotDebugStore().getRecords()).toMatchObject({ records: [], hasMore: false })
    expect(await first.control.getOneBotDebugStore().getRecords()).toMatchObject({ records: [], hasMore: false })
  })

  /**
   * 「记录不存在」这句判定归记录库，两种证据的提示因此同形；显式空间与联邦视图逐字相同。
   */
  it('显式空间与联邦视图读不到调试记录时的提示逐字相同，且都是领域错误', async () => {
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { runtimeBots })
    const spaces = new SandboxTestSpaceService(app, runtimeBots)
    const space = spaces.createSpace({ name: '空间 A' })
    const listeners = new Map<string, (...args: any[]) => any>()
    registerConsole({
      addEntry() {},
      addListener(event, callback) { listeners.set(event, callback as never) },
      broadcast() {},
    }, control, appearance, undefined, spaces)

    const getRecord = listeners.get('onebot-sandbox.debug-record')
    if (!getRecord) throw new Error('调试记录详情监听器未注册')
    for (const scope of [{}, { spaceId: space.id }]) {
      await expect(getRecord({ ...scope, recordId: '不存在的记录' }), JSON.stringify(scope))
        .rejects.toThrow(SandboxDomainError)
      await expect(getRecord({ ...scope, recordId: '不存在的记录' }), JSON.stringify(scope))
        .rejects.toThrow('调试记录不存在：不存在的记录')
    }
  })
})
