import { App } from '@koishijs/core'
import { describe, expect, it, vi } from 'vitest'
import { observeCharacterTurnCompletion } from '../src/chatluna/character-turn-completion'
import { SandboxControlService } from '../src/control-service'
import { PresetRuntimeSnapshotTracker } from '../src/presets'
import { createGroupSession } from './helpers/chatluna-state-broadcast'

function session(channelId = 'group:30001') {
  return {
    platform: 'onebot',
    selfId: '20001',
    channelId,
    guildId: channelId.slice('group:'.length),
    userId: '10001',
    bot: { selfId: '20001', platform: 'onebot' },
    channel: { id: channelId },
  }
}

function payload(value: ReturnType<typeof session>, identity = '角色') {
  return {
    session: value,
    presetName: 'shared-character',
    preset: {
      name: 'shared-character',
      system: { rawString: `身份：${identity}` },
      input: { rawString: '问题：{prompt}' },
    },
  }
}

async function emit(app: App, event: string, ...args: unknown[]): Promise<void> {
  await (app.parallel as unknown as (event: string, ...args: unknown[]) => Promise<void>)(event, ...args)
}

async function emitCollect(app: App, value: unknown): Promise<void> {
  await emit(app, 'chatluna_character/message_collect', value, [])
}

async function emitBefore(app: App, value: ReturnType<typeof payload>): Promise<void> {
  await emit(app, 'chatluna_character/before-chat', value)
}

function createPresetTracker(app: App) {
  return new PresetRuntimeSnapshotTracker(app, ({ botId, conversationId }) => ({
    scopeId: 'main',
    botId,
    conversationId,
  }))
}

interface StudioFixtureState {
  original: (this: unknown, session: unknown, ...args: unknown[]) => unknown
  wrapper: (this: unknown, session: unknown, ...args: unknown[]) => unknown
  active: boolean
}

/** 自包含复刻 Studio 已发布观察策略，只用于验证两个独立插件包装同一方法时的组合边界。 */
function installStudioStrategyFixture(
  app: App,
  service: { releaseResponseLock: (this: unknown, session: unknown, ...args: unknown[]) => unknown },
  notify: (session: unknown) => void,
) {
  let current: StudioFixtureState | undefined
  const disposeListener = app.on('chatluna_character/before-chat' as any, ((value: { session?: unknown }) => {
    if (current && service.releaseResponseLock === current.wrapper) return
    if (current) current.active = false
    const original = service.releaseResponseLock
    const state = { original, active: true } as StudioFixtureState
    state.wrapper = function (this: unknown, session: unknown, ...args: unknown[]) {
      if (state.active) notify(session)
      return original.apply(this, [session, ...args])
    }
    service.releaseResponseLock = state.wrapper
    current = state
  }) as any)
  return () => {
    disposeListener()
    if (!current) return
    current.active = false
    if (service.releaseResponseLock === current.wrapper) service.releaseResponseLock = current.original
  }
}

describe('Character 真实终态观察', () => {
  it('同步通知后原样保留 this、参数、Promise 身份与异常，并隔离通知错误', async () => {
    const app = new App()
    const order: string[] = []
    const returned = Promise.resolve('released')
    const thrown = new Error('release failed')
    let shouldThrow = false
    const original = vi.fn(function (this: unknown, _session: unknown, marker: string) {
      order.push('original')
      expect(this).toBe(service)
      if (shouldThrow) throw thrown
      return returned
    })
    const service = { releaseResponseLock: original }
    app.set('chatluna_character', service)
    const dispose = observeCharacterTurnCompletion(app, () => {
      order.push('notify')
      throw new Error('Sandbox notification failed')
    })
    await app.start()

    try {
      const current = session()
      await emitCollect(app, current)
      const actual = service.releaseResponseLock(current, 'first')
      expect(actual).toBe(returned)
      expect(order).toEqual(['notify', 'original'])
      expect(original).toHaveBeenLastCalledWith(current, 'first')

      order.length = 0
      shouldThrow = true
      await emitCollect(app, current)
      expect(() => service.releaseResponseLock(current, 'second')).toThrow(thrown)
      expect(order).toEqual(['notify', 'original'])
      expect(original).toHaveBeenLastCalledWith(current, 'second')

      dispose()
      expect(service.releaseResponseLock).toBe(original)
    } finally {
      dispose()
      await app.stop()
    }
  })

  it('多个观察者任意卸载时只移除自己，最后一个卸载恢复原方法', async () => {
    const app = new App()
    const original = vi.fn((_session: unknown) => undefined)
    const service = { releaseResponseLock: original }
    app.set('chatluna_character', service)
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = observeCharacterTurnCompletion(app, first)
    const disposeSecond = observeCharacterTurnCompletion(app, second)
    await app.start()

    try {
      const current = session()
      await emitCollect(app, current)
      const wrapped = service.releaseResponseLock
      expect(wrapped).not.toBe(original)

      disposeFirst()
      expect(service.releaseResponseLock).toBe(wrapped)
      service.releaseResponseLock(current)
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)

      disposeSecond()
      expect(service.releaseResponseLock).toBe(original)
    } finally {
      disposeFirst()
      disposeSecond()
      await app.stop()
    }
  })

  it('服务后装与替换后在下一次 message_collect 懒绑定当前实例', async () => {
    const app = new App()
    const notify = vi.fn()
    const dispose = observeCharacterTurnCompletion(app, notify)
    await app.start()

    try {
      const firstOriginal = vi.fn((_session: unknown) => undefined)
      const firstService = { releaseResponseLock: firstOriginal }
      app.set('chatluna_character', firstService)
      const firstSession = session('group:30001')
      await emitCollect(app, firstSession)

      app.set('chatluna_character', undefined)
      const secondOriginal = vi.fn((_session: unknown) => undefined)
      const secondService = { releaseResponseLock: secondOriginal }
      app.set('chatluna_character', secondService)
      const secondSession = session('group:30002')
      await emitCollect(app, secondSession)

      firstService.releaseResponseLock(firstSession)
      secondService.releaseResponseLock(secondSession)
      expect(notify).toHaveBeenCalledTimes(2)
      expect(firstOriginal).toHaveBeenCalledTimes(1)
      expect(secondOriginal).toHaveBeenCalledTimes(1)

      dispose()
      expect(firstService.releaseResponseLock).toBe(firstOriginal)
      expect(secondService.releaseResponseLock).toBe(secondOriginal)
    } finally {
      dispose()
      await app.stop()
    }
  })

  it('已有消费者在 message_collect 内立即 release 时仍先 begin 并完成收尾', async () => {
    const app = new App()
    let control: SandboxControlService | undefined
    const thinkingAtOriginal: boolean[] = []
    const service = {
      releaseResponseLock(_session: unknown) {
        thinkingAtOriginal.push(control!.getChatLunaStates().some(({ thinking }) => thinking))
      },
    }
    app.set('chatluna_character', service)
    // 模拟 Character 已先注册的 collect 消费者，且回调在首次 await 前直接进入 finally。
    app.on('chatluna_character/message_collect' as any, ((current: unknown) => {
      service.releaseResponseLock(current)
    }) as any)
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx)
      observeCharacterTurnCompletion(ctx, current => control!.finishChatLunaCharacterTurn(current))
    })
    await app.start()

    try {
      const current = createGroupSession(control!, '20001')
      await emitCollect(app, current)
      expect(thinkingAtOriginal).toEqual([false])
      expect(control!.getChatLunaStates()).toEqual([
        expect.objectContaining({ botParticipantId: '20001', conversationId: 'group:30001', thinking: false }),
      ])
    } finally {
      await app.stop()
    }
  })

  it('原 release 唤醒同 Session 新轮时，旧轮先收尾且新轮保持活动', async () => {
    const app = new App()
    const states = new SandboxControlService(app)
    const presets = createPresetTracker(app)
    const current = createGroupSession(states, '20001')
    const nextPayload = payload(current as any, '新角色')
    const original = vi.fn(function (_session: unknown) {
      return Promise.all([emitCollect(app, current), emitBefore(app, nextPayload)])
    })
    const service = { releaseResponseLock: original }
    app.set('chatluna_character', service)
    const dispose = observeCharacterTurnCompletion(app, releasedSession => {
      states.finishChatLunaCharacterTurn(releasedSession)
      presets.finishCharacterTurn(releasedSession)
    })
    await app.start()

    try {
      await emitCollect(app, current)
      await emitBefore(app, payload(current as any, '旧角色'))
      await service.releaseResponseLock(current)

      expect(states.getChatLunaStates()).toEqual([
        expect.objectContaining({ conversationId: 'group:30001', thinking: true }),
      ])
      expect(presets.getActiveSnapshots({ scopeId: 'main', botId: '20001', conversationId: 'group:30001' })[0]?.templates[0])
        .toMatchObject({ template: '身份：新角色' })
    } finally {
      dispose()
      presets.dispose()
      await states.dispose()
      await app.stop()
    }
  })

  it('过期、克隆或无关 Session 的 release 不删除同目标后继轮，真实并发仍逐轮收尾', async () => {
    const app = new App()
    const states = new SandboxControlService(app)
    const presets = createPresetTracker(app)
    const service = { releaseResponseLock: vi.fn((_session: unknown) => undefined) }
    app.set('chatluna_character', service)
    const dispose = observeCharacterTurnCompletion(app, releasedSession => {
      states.finishChatLunaCharacterTurn(releasedSession)
      presets.finishCharacterTurn(releasedSession)
    })
    await app.start()

    try {
      const stale = createGroupSession(states, '20001')
      const next = createGroupSession(states, '20001')
      await emitCollect(app, stale)
      await emitBefore(app, payload(stale as any, '旧角色'))
      await emitCollect(app, next)
      await emitBefore(app, payload(next as any, '新角色'))

      service.releaseResponseLock({ ...stale })
      service.releaseResponseLock(stale)
      expect(states.getChatLunaStates()).toEqual([
        expect.objectContaining({ conversationId: 'group:30001', thinking: true }),
      ])
      expect(presets.getActiveSnapshots({ scopeId: 'main', botId: '20001', conversationId: 'group:30001' }))
        .toMatchObject([{ templates: [{ template: '身份：新角色' }, expect.anything()] }])

      const direct = session('private:10001:20001')
      await emitCollect(app, direct)
      await emitBefore(app, payload(direct, '私聊角色'))
      service.releaseResponseLock(next)
      expect(states.getChatLunaStates()).toEqual(expect.arrayContaining([
        expect.objectContaining({ conversationId: 'group:30001', thinking: false }),
        expect.objectContaining({ conversationId: 'private:10001:20001', thinking: true }),
      ]))
      service.releaseResponseLock(direct)
      expect(states.getThinkingModelRequestTargets()).toEqual([])
    } finally {
      dispose()
      presets.dispose()
      await states.dispose()
      await app.stop()
    }
  })

  it.each(['sandbox', 'studio'] as const)('与 Studio 策略共存多轮且先卸载 %s 不覆盖另一方包装', async (disposeFirst) => {
    const app = new App()
    const counts = { original: 0, sandbox: 0, studio: 0 }
    const original = vi.fn((_session: unknown) => {
      counts.original += 1
    })
    const service = { releaseResponseLock: original as (session: unknown) => unknown }
    app.set('chatluna_character', service)
    const disposeStudio = installStudioStrategyFixture(app, service, () => {
      counts.studio += 1
    })
    const disposeSandbox = observeCharacterTurnCompletion(app, () => {
      counts.sandbox += 1
    })
    await app.start()

    try {
      let stableIdentity: typeof service.releaseResponseLock | undefined
      for (let round = 0; round < 5; round += 1) {
        const current = session()
        await emitCollect(app, current)
        await emitBefore(app, payload(current))
        if (round === 0) stableIdentity = service.releaseResponseLock
        else expect(service.releaseResponseLock).toBe(stableIdentity)
        service.releaseResponseLock(current)
      }
      expect(counts).toEqual({ original: 5, sandbox: 5, studio: 5 })

      const outerIdentity = service.releaseResponseLock
      if (disposeFirst === 'sandbox') disposeSandbox()
      else disposeStudio()
      if (disposeFirst === 'sandbox') expect(service.releaseResponseLock).toBe(outerIdentity)

      const finalSession = session()
      await emitCollect(app, finalSession)
      await emitBefore(app, payload(finalSession))
      service.releaseResponseLock(finalSession)
      expect(counts).toEqual(disposeFirst === 'sandbox'
        ? { original: 6, sandbox: 5, studio: 6 }
        : { original: 6, sandbox: 6, studio: 5 })
    } finally {
      disposeStudio()
      disposeSandbox()
      await app.stop()
    }
  })
})
