import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { Config, Settings } from '../src'
import { registerSettings, SETTINGS_SAVE_ACTION, SETTINGS_STATE, type SandboxSettingsView } from '../src/settings'

function createHost(entryId: string | undefined, stored: Record<string, unknown> | undefined) {
  const states = new Map<string, { get(): unknown }>()
  const actions = new Map<string, (input: unknown, context: { user: string }) => Promise<unknown>>()
  const saves: unknown[] = []
  const inner = {
    chatluna_webui: {
      state: (key: string, options: { get(): unknown }) => states.set(key, options),
      action: (name: string, _options: unknown, fn: (input: unknown, context: { user: string }) => Promise<unknown>) => actions.set(name, fn),
    },
    chatluna_config: {
      entry: (id: string) => (id === 'onebot-sandbox:abc' ? { id, config: stored } : undefined),
      idOf: () => 'onebot-sandbox:abc',
      fileStamp: () => 'stamp-1',
      save: async (input: unknown) => void saves.push(input),
    },
  }
  const ctx = {
    fiber: { entry: entryId === undefined ? undefined : { options: { id: entryId } } },
    inject: (_deps: string[], callback: (inner: unknown) => void) => callback(inner),
  } as unknown as Context
  registerSettings(ctx, Settings, 'chatluna-plugin-onebot-sandbox')
  return {
    read: () => states.get(SETTINGS_STATE)!.get() as SandboxSettingsView,
    save: (input: unknown) => actions.get(SETTINGS_SAVE_ACTION)!(input, { user: 'owner' }),
    saves,
  }
}

describe('插件设置', () => {
  it('v2 插件页的 schema 隐藏全部字段，设置页的 schema 保持可见', () => {
    expect(Object.keys(Config.dict ?? {})).toEqual(Object.keys(Settings.dict ?? {}))
    expect(Object.values(Config.dict ?? {}).every((field) => field.meta.hidden)).toBe(true)
    expect(Object.values(Settings.dict ?? {}).some((field) => field.meta.hidden)).toBe(false)
    // 字段全部隐藏后，loader 仍能按同一份 schema 补默认值。
    expect(Config({}).sceneMessageLimit).toBe(Settings({}).sceneMessageLimit)
  })

  it('读到的是条目原样存储的值与文件戳', () => {
    const host = createHost('onebot-sandbox:abc', { sceneMessageLimit: 100 })
    const view = host.read()
    expect(view.value).toEqual({ sceneMessageLimit: 100 })
    expect(view.revision).toBe('stamp-1')
    expect(view.schema.refs[view.schema.uid]?.type).toBe('object')
  })

  it('保存写回插件自己的条目并带上乐观锁', async () => {
    const host = createHost('onebot-sandbox:abc', {})
    await host.save({ config: { sceneMessageLimit: 10 }, revision: 'stamp-1' })
    expect(host.saves).toEqual([{
      id: 'onebot-sandbox:abc',
      options: { config: { sceneMessageLimit: 10 } },
      by: 'webui:owner',
      revision: 'stamp-1',
    }])
  })

  it('不符合 schema 的值拒绝写入', async () => {
    const host = createHost('onebot-sandbox:abc', {})
    await expect(host.save({ config: { sceneMessageLimit: 0 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(host.saves).toEqual([])
  })

  it('没有 loader 条目时按包名找条目', () => {
    const host = createHost(undefined, { persistenceMode: 'memory' })
    expect(host.read().value).toEqual({ persistenceMode: 'memory' })
  })
})
