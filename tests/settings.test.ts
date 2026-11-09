import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
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
    // 设置页的 schema 是分区的 intersect，分区里还可能再嵌一层 intersect 分小节。
    const fieldsOf = (schema: Schema): Array<[string, Schema]> =>
      schema.type === 'intersect' ? (schema.list ?? []).flatMap(fieldsOf) : Object.entries(schema.dict ?? {})
    const fields = fieldsOf(Settings)
    expect(Object.keys(Config.dict ?? {}).sort()).toEqual(fields.map(([key]) => key).sort())
    expect(Object.values(Config.dict ?? {}).every((field) => field.meta.hidden)).toBe(true)
    expect(fields.some(([, field]) => field.meta.hidden)).toBe(false)
    // 每个分区都带标题，设置页的导航与面板标题取自这里。
    expect((Settings.list ?? []).every((section) => typeof section.meta.label === 'string')).toBe(true)
    // 字段全部隐藏后，loader 仍能按同一份 schema 补默认值。
    expect(Config({}).sceneMessageLimit).toBe(Settings({}).sceneMessageLimit)
  })

  it('读到的是条目原样存储的值与文件戳', () => {
    const host = createHost('onebot-sandbox:abc', { sceneMessageLimit: 100 })
    const view = host.read()
    expect(view.value).toEqual({ sceneMessageLimit: 100 })
    expect(view.revision).toBe('stamp-1')
    // 根节点是分区的 intersect，设置页据此拆出导航（`client/settings/page.tsx`）。
    expect(view.schema.refs[view.schema.uid]?.type).toBe('intersect')
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

  it('单文件上限可以保存，超出范围时不写入配置', async () => {
    const host = createHost('onebot-sandbox:abc', {})
    await host.save({ config: { mediaMaxSizeMiB: 50 }, revision: 'stamp-1' })
    expect(host.saves).toMatchObject([{ options: { config: { mediaMaxSizeMiB: 50 } } }])
    await expect(host.save({ config: { mediaMaxSizeMiB: 0 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(host.saves).toHaveLength(1)
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
