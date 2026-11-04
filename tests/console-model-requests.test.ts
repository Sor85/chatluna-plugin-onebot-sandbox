import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxModelRequestStore } from '../src/model-request'
import { SandboxTestSpaceService } from '../src/test-spaces'
import type { SandboxAppearance } from '../src/types'
import { SandboxDomainError } from '../src/types'
import type { ChatLunaUsageLookup } from '../src/chatluna/usage'

const appearance: SandboxAppearance = {
  enableSandboxFrostedGlass: true,
  sandboxTimBubbleTail: true,
  sandboxColorMode: 'auto',
  sandboxAccentColor: '#2563eb',
  sandboxMarkRecalledMessages: true,
}

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

describe('模型请求 Console 协议', () => {
  it('按分类读取和清理主环境、测试空间与未归属记录', async () => {
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { runtimeBots })
    const spaces = new SandboxTestSpaceService(app, runtimeBots)
    const space = spaces.createSpace({ name: '请求空间' })
    const unattributed = new SandboxModelRequestStore()
    const listeners = new Map<string, unknown>()
    const registrar: SandboxConsoleRegistrar = {
      addEntry() {},
      addListener(event, callback) {
        listeners.set(event, callback)
      },
      broadcast() {},
    }
    registerConsole(registrar, control, appearance, undefined, spaces, unattributed)

    const mainRecord = control.getModelRequestStore().append({
      status: 'success', durationMs: 3, model: 'main-model',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    space.control.getModelRequestStore().append({
      status: 'success', durationMs: 4, model: 'space-model',
      attribution: 'attributed', entities: { scopeId: space.id }, requestBodyAvailable: false,
    })
    const unattributedRecord = unattributed.append({
      status: 'error', durationMs: 5, model: 'lost-model',
      attribution: 'unattributed', entities: {}, requestBodyAvailable: true,
      requestBody: { model: 'lost-model', messages: [] },
      responseBodyStatus: 'complete', responseBodyFormat: 'json', responseStatus: 500,
      responseBodyRaw: JSON.stringify({ error: 'failed' }),
    })

    const listRecords = listeners.get('onebot-sandbox.model-request-records')
    const getRecord = listeners.get('onebot-sandbox.model-request-record')
    const getTrajectory = listeners.get('onebot-sandbox.model-request-trajectory')
    const clearRecords = listeners.get('onebot-sandbox.clear-model-request-records')
    if (typeof listRecords !== 'function' || typeof getRecord !== 'function' || typeof getTrajectory !== 'function' || typeof clearRecords !== 'function') {
      throw new Error('模型请求记录监听器未注册')
    }

    expect(await Reflect.apply(listRecords, undefined, [{ scope: 'space', spaceId: 'main' }])).toMatchObject({
      records: [expect.objectContaining({ id: mainRecord.id, model: 'main-model' })],
    })
    expect(await Reflect.apply(listRecords, undefined, [{ scope: 'space', spaceId: space.id }])).toMatchObject({
      records: [expect.objectContaining({ model: 'space-model' })],
    })
    const unattributedPage = await Reflect.apply(listRecords, undefined, [{ scope: 'unattributed' }]) as { records: Array<{ id: string }> }
    expect(unattributedPage.records[0]).toMatchObject({ id: unattributedRecord.id, model: 'lost-model' })
    expect(unattributedPage.records[0]).not.toHaveProperty('requestBody')
    expect(unattributedPage.records[0]).not.toHaveProperty('responseBodyRaw')
    expect(await Reflect.apply(getRecord, undefined, [{ scope: 'unattributed', recordId: unattributedRecord.id }])).toMatchObject({
      id: unattributedRecord.id,
      requestBody: { model: 'lost-model', messages: [] },
      responseBodyStatus: 'complete',
      responseBodyFormat: 'json',
      responseStatus: 500,
      responseBodyRaw: JSON.stringify({ error: 'failed' }),
    })
    expect(await Reflect.apply(getTrajectory, undefined, [{ scope: 'unattributed', recordId: unattributedRecord.id, mode: 'request' }])).toMatchObject({
      mode: 'request',
      records: [expect.objectContaining({ id: unattributedRecord.id })],
      rows: [expect.objectContaining({ kind: 'request', requestId: unattributedRecord.id })],
    })

    const allPage = await Reflect.apply(listRecords, undefined, [{ scope: 'all' }]) as { records: Array<{ model: string, source: { type: string } }> }
    expect(allPage.records.map(({ model }) => model).sort()).toEqual(['main-model', 'space-model'])
    expect(allPage.records.some(({ source }) => source.type === 'unattributed')).toBe(false)
    await expect(Reflect.apply(clearRecords, undefined, [{ scope: 'all' }])).rejects.toThrow('全部空间视图不支持一次性清理')

    expect(await Reflect.apply(clearRecords, undefined, [{ scope: 'space', spaceId: space.id }])).toEqual({ cleared: 1 })
    expect((await space.control.getModelRequestStore().getRecords()).records).toEqual([])
    expect((await control.getModelRequestStore().getRecords()).records).toHaveLength(1)
    expect(await Reflect.apply(clearRecords, undefined, [{ scope: 'unattributed' }])).toEqual({ cleared: 1 })
    expect((await unattributed.getRecords()).records).toEqual([])
  })

  /**
   * 「记录不存在」这句判定归记录库，因此三种范围下的提示必须逐字相同——用户不必先分辨
   * 自己当时在哪个视图。跨记录域那一处的判定留在调用方，但文案与单记录域同源。
   */
  it('单空间、未归属与全部空间读不到记录时的提示逐字相同，且都是领域错误', async () => {
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { runtimeBots })
    const spaces = new SandboxTestSpaceService(app, runtimeBots)
    const space = spaces.createSpace({ name: '请求空间' })
    const listeners = new Map<string, (...args: any[]) => any>()
    registerConsole({
      addEntry() {},
      addListener(event, callback) { listeners.set(event, callback as never) },
      broadcast() {},
    }, control, appearance, undefined, spaces, new SandboxModelRequestStore())

    const getRecord = listeners.get('onebot-sandbox.model-request-record')
    if (!getRecord) throw new Error('模型请求详情监听器未注册')
    for (const scope of [
      { scope: 'main' },
      { scope: 'space', spaceId: space.id },
      { scope: 'unattributed' },
      { scope: 'all' },
    ]) {
      await expect(getRecord({ ...scope, recordId: '不存在的记录' }), JSON.stringify(scope))
        .rejects.toThrow(SandboxDomainError)
      await expect(getRecord({ ...scope, recordId: '不存在的记录' }), JSON.stringify(scope))
        .rejects.toThrow('模型请求记录不存在：不存在的记录')
    }
  })

  /**
   * 会话轨迹要按记录域取到那条记录所属的记录库才聚得起同会话步骤。三种来路各断言一次：
   * 收拢前这里是按来路三层嵌套的三元表达式，换一种来路就多一层。
   */
  it('主环境、测试空间与未归属三种来路的会话轨迹都聚得起同会话步骤', async () => {
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { runtimeBots })
    const spaces = new SandboxTestSpaceService(app, runtimeBots)
    const space = spaces.createSpace({ name: '轨迹空间' })
    const unattributed = new SandboxModelRequestStore()
    const listeners = new Map<string, (...args: any[]) => any>()
    registerConsole({
      addEntry() {},
      addListener(event, callback) { listeners.set(event, callback as never) },
      broadcast() {},
    }, control, appearance, undefined, spaces, unattributed)

    const request = (model: string, conversationId: string) => ({
      status: 'success' as const,
      durationMs: 1,
      model,
      attribution: 'attributed' as const,
      entities: { scopeId: 'main', botId: '20001', conversationId },
      requestBodyAvailable: true,
      requestBody: { model, messages: [{ role: 'user', content: model }] },
    })
    const mainStore = control.getModelRequestStore()
    const spaceStore = space.control.getModelRequestStore()
    const mainFirst = mainStore.append(request('main-1', 'private:10001:20001'))
    mainStore.append(request('main-2', 'private:10001:20001'))
    const spaceFirst = spaceStore.append(request('space-1', 'group:30001'))
    spaceStore.append(request('space-2', 'group:30001'))
    const lostFirst = unattributed.append({ ...request('lost-1', 'group:30002'), attribution: 'unattributed' })
    unattributed.append({ ...request('lost-2', 'group:30002'), attribution: 'unattributed' })

    const trajectory = listeners.get('onebot-sandbox.model-request-trajectory')
    if (!trajectory) throw new Error('模型请求轨迹监听器未注册')
    const models = async (input: unknown) => (
      (await trajectory(input) as { records: Array<{ model?: string }> }).records.map(({ model }) => model)
    )

    expect(await models({ scope: 'main', recordId: mainFirst.id, mode: 'conversation' })).toEqual(['main-1', 'main-2'])
    expect(await models({ scope: 'space', spaceId: space.id, recordId: spaceFirst.id, mode: 'conversation' })).toEqual(['space-1', 'space-2'])
    expect(await models({ scope: 'unattributed', recordId: lostFirst.id, mode: 'conversation' })).toEqual(['lost-1', 'lost-2'])
    // 全部空间视图下来源标注决定去哪个记录库聚合，主环境与测试空间各走一次。
    expect(await models({ scope: 'all', recordId: mainFirst.id, mode: 'conversation' })).toEqual(['main-1', 'main-2'])
    expect(await models({ scope: 'all', recordId: spaceFirst.id, mode: 'conversation' })).toEqual(['space-1', 'space-2'])
  })

  it('在详情读取时解析后加载的 ChatLuna Usage 服务', async () => {
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { runtimeBots })
    const listeners = new Map<string, unknown>()
    const registrar: SandboxConsoleRegistrar = {
      addEntry() {},
      addListener(event, callback) {
        listeners.set(event, callback)
      },
      broadcast() {},
    }
    let usageService: ChatLunaUsageLookup | undefined
    registerConsole(registrar, control, appearance, undefined, undefined, undefined, () => usageService)

    const record = control.getModelRequestStore().append({
      status: 'success', durationMs: 5613, model: 'gemini-3.7-flash-high',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    usageService = {
      async list() {
        return {
          rows: [{
            inputTokens: 10469,
            outputTokens: 696,
            reasoningTokens: 609,
            cachedTokens: 0,
            totalTokens: 11165,
            model: 'gemini-3.7-flash-high',
            createdAt: record.createdAt,
            ttftMs: 5613,
            totalMs: 5613,
            tps: 232.495991448423,
          }],
        }
      },
    }

    const getRecord = listeners.get('onebot-sandbox.model-request-record')
    if (typeof getRecord !== 'function') throw new Error('模型请求详情监听器未注册')
    await expect(Reflect.apply(getRecord, undefined, [{ scope: 'space', spaceId: 'main', recordId: record.id }])).resolves.toMatchObject({
      usage: {
        inputTokens: 10469,
        outputTokens: 696,
        reasoningTokens: 609,
        totalTokens: 11165,
        ttftMs: 5613,
        totalMs: 5613,
        tps: 232.495991448423,
        source: 'chatluna-usage',
      },
    })
  })
})
