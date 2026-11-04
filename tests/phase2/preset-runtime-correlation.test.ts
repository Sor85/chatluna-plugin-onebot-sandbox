import { App } from '@koishijs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PresetRuntimeSnapshotTracker,
  type PresetRuntimeResolvedTarget,
} from '../src/presets'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

function session(botId: string, conversationId: string) {
  return { selfId: botId, channelId: conversationId, bot: { selfId: botId }, channel: { id: conversationId } }
}

function createTracker(app: App, targets: Record<string, PresetRuntimeResolvedTarget | undefined>) {
  return new PresetRuntimeSnapshotTracker(app, ({ botId, conversationId }) => targets[`${botId}:${conversationId}`])
}

function emit(app: App, event: string, ...args: unknown[]): Promise<void> {
  return (app.parallel as unknown as (event: string, ...args: unknown[]) => Promise<void>)(event, ...args)
}

describe('运行时预设快照关联', () => {
  it('从核心公共事件与预设服务立即复制快照，并保持到成功完成', async () => {
    const app = new App()
    runningApps.push(app)
    const target = { scopeId: 'space-a', botId: '21001', conversationId: 'private:11001:21001' }
    const tracker = createTracker(app, { '21001:private:11001:21001': target })
    await app.start()

    const preset = {
      rawText: 'prompts:\n  - role: system\n    content: Hello {name}.\n',
      messages: [{ content: 'Hello {name}.', _getType: () => 'system' }],
      formatUserPromptString: 'Ask {prompt}',
    }
    const variables = { built: { preset: 'demo' } }
    const currentSession = session(target.botId, target.conversationId)
    await emit(app, 'chatluna/before-chat', 'core-turn', {}, variables, {
      ctx: { chatluna: { preset: { getPreset: () => ({ value: preset }) } } },
    }, currentSession)

    preset.rawText = 'changed after event'
    preset.messages[0]!.content = 'changed after event'
    variables.built.preset = 'changed-after-event'

    expect(tracker.getActiveSnapshots(target)).toEqual([{
      kind: 'core',
      presetName: 'demo',
      capturedAt: expect.any(String),
      source: 'prompts:\n  - role: system\n    content: Hello {name}.\n',
      templates: [
        { path: ['prompts', 0, 'content'], role: 'system', template: 'Hello {name}.' },
        { path: ['format_user_prompt'], role: 'user', template: 'Ask {prompt}' },
      ],
    }])

    await emit(app, 'chatluna/after-chat', 'core-turn', {}, {}, variables, {}, currentSession)
    expect(tracker.getActiveSnapshots(target)).toEqual([])
    tracker.dispose()
  })

  it('从 Character before-chat 捕获 raw system/input，并按目标和回合隔离到 after-chat', async () => {
    const app = new App()
    runningApps.push(app)
    const first = { scopeId: 'main', botId: '20001', conversationId: 'group:30001' }
    const second = { scopeId: 'space-b', botId: '22001', conversationId: 'group:33001' }
    const tracker = createTracker(app, {
      '20001:group:30001': first,
      '22001:group:33001': second,
    })
    await app.start()

    const firstPayload = {
      session: session(first.botId, first.conversationId),
      presetName: 'alice',
      preset: {
        name: 'alice',
        system: { rawString: 'System {status}' },
        input: { rawString: 'Input {prompt}' },
      },
    }
    const secondPayload = {
      session: session(second.botId, second.conversationId),
      presetName: 'bob',
      preset: {
        name: 'bob',
        system: { rawString: 'Bob system' },
        input: { rawString: 'Bob {prompt}' },
      },
    }
    await emit(app, 'chatluna_character/before-chat', firstPayload)
    await emit(app, 'chatluna_character/before-chat', secondPayload)
    firstPayload.preset.system.rawString = 'mutated'

    expect(tracker.getActiveSnapshots(first)).toMatchObject([{
      kind: 'character',
      presetName: 'alice',
      templates: [
        { path: ['system'], role: 'system', template: 'System {status}' },
        { path: ['input'], role: 'user', template: 'Input {prompt}' },
      ],
    }])
    expect(tracker.getActiveSnapshots(second)).toMatchObject([{ presetName: 'bob' }])

    await emit(app, 'chatluna_character/after-chat', firstPayload)
    expect(tracker.getActiveSnapshots(first)).toEqual([])
    expect(tracker.getActiveSnapshots(second)).toHaveLength(1)
    tracker.dispose()
  })

  it('Character 按原 Session 精确收尾，克隆或过期 Session 不删除同目标后继轮', async () => {
    const app = new App()
    runningApps.push(app)
    const target = { scopeId: 'main', botId: '20001', conversationId: 'group:30001' }
    const tracker = createTracker(app, { '20001:group:30001': target })
    await app.start()

    const stale = {
      session: session(target.botId, target.conversationId),
      presetName: 'stale',
      preset: { name: 'stale', system: { rawString: 'Stale system' } },
    }
    const current = {
      session: session(target.botId, target.conversationId),
      presetName: 'current',
      preset: { name: 'current', system: { rawString: 'Current system' } },
    }
    await emit(app, 'chatluna_character/before-chat', stale)
    await emit(app, 'chatluna_character/before-chat', current)

    tracker.finishCharacterTurn({ ...current.session })
    tracker.finishCharacterTurn(stale.session)
    expect(tracker.getActiveSnapshots(target)).toMatchObject([{
      kind: 'character',
      presetName: 'current',
      templates: [{ template: 'Current system' }],
    }])

    tracker.finishCharacterTurn(current.session)
    expect(tracker.getActiveSnapshots(target)).toEqual([])
    tracker.dispose()
  })

  it('同一目标重叠的核心与 Character 生命周期会同时附加两个快照', async () => {
    const app = new App()
    runningApps.push(app)
    const target = { scopeId: 'main', botId: '20001', conversationId: 'private:10001:20001' }
    const tracker = createTracker(app, { '20001:private:10001:20001': target })
    await app.start()

    await emit(app, 'chatluna/before-chat', 'core-turn', {}, { built: { preset: 'core-demo' } }, {
      ctx: { chatluna: { preset: { getPreset: () => ({ value: {
        rawText: 'prompts:\n  - role: system\n    content: Core {value}\n',
        messages: [{ content: 'Core {value}', _getType: () => 'system' }],
      } }) } } },
    }, session(target.botId, target.conversationId))
    await emit(app, 'chatluna_character/before-chat', {
      session: session(target.botId, target.conversationId),
      presetName: 'character-demo',
      preset: { name: 'character-demo', system: { rawString: 'Character {value}' } },
    })

    expect(tracker.getActiveSnapshots(target)).toMatchObject([
      { kind: 'core', presetName: 'core-demo' },
      { kind: 'character', presetName: 'character-demo' },
    ])
    tracker.dispose()
  })

  it('同类核心并发回合无法区分时不覆盖或猜测，错误完成也保持保守', async () => {
    const app = new App()
    runningApps.push(app)
    const target = { scopeId: 'main', botId: '20001', conversationId: 'private:10001:20001' }
    const tracker = createTracker(app, { '20001:private:10001:20001': target })
    await app.start()

    const makeInterface = (name: string) => ({
      ctx: { chatluna: { preset: { getPreset: () => ({ value: {
        rawText: `prompts:\n  - role: system\n    content: ${name} {value}\n`,
        messages: [{ content: `${name} {value}`, _getType: () => 'system' }],
      } }) } } },
    })
    const currentSession = session(target.botId, target.conversationId)
    await emit(app, 'chatluna/before-chat', 'same-upstream-turn', {}, { built: { preset: 'first' } }, makeInterface('First'), currentSession)
    await emit(app, 'chatluna/before-chat', 'same-upstream-turn', {}, { built: { preset: 'second' } }, makeInterface('Second'), currentSession)

    expect(tracker.getActiveSnapshots(target)).toEqual([])
    await emit(app, 'chatluna/after-chat-error', new Error('failed'), 'same-upstream-turn')
    expect(tracker.getActiveSnapshots(target)).toEqual([])
    tracker.dispose()
  })

  it('核心成功完成按 session 目标清理，缺少 session 的错误完成在跨目标歧义时不清理', async () => {
    const app = new App()
    runningApps.push(app)
    const first = { scopeId: 'main', botId: '20001', conversationId: 'group:30001' }
    const second = { scopeId: 'space-b', botId: '22001', conversationId: 'group:33001' }
    const tracker = createTracker(app, {
      '20001:group:30001': first,
      '22001:group:33001': second,
    })
    await app.start()

    const makeInterface = (name: string) => ({
      ctx: { chatluna: { preset: { getPreset: () => ({ value: {
        rawText: `prompts:\n  - role: system\n    content: ${name} {value}\n`,
        messages: [{ content: `${name} {value}`, _getType: () => 'system' }],
      } }) } } },
    })
    await emit(app, 'chatluna/before-chat', 'shared-upstream-turn', {}, { built: { preset: 'first' } }, makeInterface('First'), session(first.botId, first.conversationId))
    await emit(app, 'chatluna/before-chat', 'shared-upstream-turn', {}, { built: { preset: 'second' } }, makeInterface('Second'), session(second.botId, second.conversationId))

    await emit(app, 'chatluna/after-chat-error', new Error('failed'), 'shared-upstream-turn')
    expect(tracker.getActiveSnapshots(first)).toMatchObject([{ presetName: 'first' }])
    expect(tracker.getActiveSnapshots(second)).toMatchObject([{ presetName: 'second' }])

    await emit(app, 'chatluna/after-chat', 'shared-upstream-turn', {}, {}, {}, {}, session(first.botId, first.conversationId))
    expect(tracker.getActiveSnapshots(first)).toEqual([])
    expect(tracker.getActiveSnapshots(second)).toMatchObject([{ presetName: 'second' }])
    tracker.dispose()
  })
})
