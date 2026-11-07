import type { Context } from 'cordis'
import Schema from 'schemastery'
import type {} from '@chatluna/preset'
import type {} from '@chatluna/ui-schema-registry'
import { findChatLunaRuntime, readRecord, SandboxChatLunaError } from './runtime'

/**
 * 测试预设：让测试者新建、修改 ChatLuna v2 的预设，并把沙盒机器人切到指定预设。
 *
 * 预设是 v2 的全局资源，不属于任何场景或测试空间，所以写权限由沙盒自己收窄：
 *
 * - ID 以 `sandbox-test-` 开头的是测试预设，只能经这里新建，可以随意修改与删除；
 * - 其余预设只有列在插件设置 `presetEditing.editablePresets` 里的才能修改，而且一律不能删除；
 * - v2 标成 `editable: 'none'` 的（插件贡献的预设）无论如何都只读。
 *
 * 切换预设写成 v2 的路由规则而不是会话级覆盖：规则持久、重启后仍生效，且与真实配置走同一条
 * 解析路径。每个机器人一条，ID 固定为 `onebot-sandbox-preset-<机器人 ID>`，筛选条件只命中
 * OneBot 平台上这个 selfId；更具体的用户规则（例如按频道写的）仍会盖过它。
 */

export const TEST_PRESET_PREFIX = 'sandbox-test-'
const RULE_PREFIX = 'onebot-sandbox-preset-'
const RULE_WRITER = 'onebot-sandbox'
const PLATFORM = 'onebot'

export interface SandboxPresetSummary {
  id: string
  name: string
  kind: string
  loader: string
  status: string
  origin: string
  revision: string
  description?: string
  diagnostics: unknown[]
  /** 测试预设：可以修改与删除。 */
  testPreset: boolean
  /** 当前设置下沙盒能否修改它。 */
  writable: boolean
}

export interface SandboxPresetAssignment {
  botId: string
  presetId: string
  ruleId: string
}

export interface SandboxPresetEditor {
  list(): { presets: SandboxPresetSummary[]; loaders: { id: string; extensions: string[] }[]; assignments: SandboxPresetAssignment[] }
  get(id: string): Promise<{ preset: SandboxPresetSummary; source?: { text: string; revision: string; file: string }; data?: unknown }>
  create(input: { id: string; loader?: string; text?: string; copyFrom?: string }): Promise<SandboxPresetSummary>
  save(id: string, text: string, revision: string): Promise<SandboxPresetSummary>
  remove(id: string, revision?: string): Promise<{ removed: string; unassignedBots: string[] }>
  assign(botId: string, presetId: string | undefined): Promise<SandboxPresetAssignment | { botId: string; presetId: null }>
}

interface PresetRecordLike {
  id: string
  name: string
  kind: string
  loader: string
  status: string
  origin: string
  editable: string
  revision: string
  description?: string
  diagnostics?: unknown[]
  data?: unknown
}

interface PresetsServiceLike {
  list(): PresetRecordLike[]
  get(id: string): PresetRecordLike | undefined
  source(id: string): Promise<{ text: string; revision: string; file: string } | undefined>
  listLoaders(): { id: string; extensions: readonly string[] }[]
  create(input: { id: string; loader: string; text?: string }, actor?: string): Promise<PresetRecordLike>
  duplicate(id: string, target: string, actor?: string): Promise<PresetRecordLike>
  save(id: string, text: string, revision: string | undefined, actor?: string): Promise<PresetRecordLike>
  remove(id: string, revision: string | undefined, actor?: string): Promise<void>
}

interface RoutingRuleLike {
  id: string
  by?: string
  revision?: number
  values?: Record<string, unknown>
}

interface RoutingServiceLike {
  rules(): RoutingRuleLike[]
  rule(id: string): RoutingRuleLike | undefined
  save(input: Record<string, unknown>, options?: { by?: string; revision?: number }): Promise<RoutingRuleLike>
  remove(id: string, options?: { by?: string; revision?: number }): Promise<void>
}

export function isTestPresetId(id: string): boolean {
  return id.startsWith(TEST_PRESET_PREFIX)
}

/** v2 的错误类型不在编译期可见，冲突按错误名识别：预设是 `PresetConflictError`，路由是 code `CONFLICT`。 */
function translateError(error: unknown): never {
  if (error instanceof SandboxChatLunaError) throw error
  const record = readRecord(error)
  const message = error instanceof Error ? error.message : String(error)
  if (record?.name === 'PresetConflictError' || record?.code === 'CONFLICT') {
    throw new SandboxChatLunaError('conflict', `${message}；重新读取后再修改`)
  }
  throw new SandboxChatLunaError('invalid', message)
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    translateError(error)
  }
}

export class SandboxChatLunaPresets implements SandboxPresetEditor {
  constructor(private host: unknown, private editablePresets: readonly string[]) {}

  private presets(): PresetsServiceLike {
    const service = findChatLunaRuntime(this.host, 'presets', (candidate) => (
      typeof candidate.list === 'function' && typeof candidate.save === 'function' ? candidate : undefined
    ))
    if (!service) throw new SandboxChatLunaError('unavailable', 'ChatLuna 的预设服务没有加载')
    return service as unknown as PresetsServiceLike
  }

  private routing(): RoutingServiceLike {
    const service = findChatLunaRuntime(this.host, 'routing', (candidate) => (
      typeof candidate.save === 'function' && typeof candidate.rules === 'function' ? candidate : undefined
    ))
    if (!service) throw new SandboxChatLunaError('unavailable', 'ChatLuna 的路由服务没有加载')
    return service as unknown as RoutingServiceLike
  }

  private writable(record: PresetRecordLike): boolean {
    if (record.editable !== 'source') return false
    return isTestPresetId(record.id) || this.editablePresets.includes(record.id)
  }

  private summarize(record: PresetRecordLike): SandboxPresetSummary {
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      loader: record.loader,
      status: record.status,
      origin: record.origin,
      revision: record.revision,
      ...(record.description ? { description: record.description } : {}),
      diagnostics: record.diagnostics ?? [],
      testPreset: isTestPresetId(record.id),
      writable: this.writable(record),
    }
  }

  private require(id: string): PresetRecordLike {
    const record = this.presets().get(id)
    if (!record) throw new SandboxChatLunaError('not_found', `预设不存在：${id}`)
    return record
  }

  private assignments(): SandboxPresetAssignment[] {
    const routing = findChatLunaRuntime(this.host, 'routing', (candidate) => (typeof candidate.rules === 'function' ? candidate : undefined))
    if (!routing) return []
    return (routing as unknown as RoutingServiceLike).rules().flatMap((rule) => {
      if (rule.by !== RULE_WRITER || !rule.id.startsWith(RULE_PREFIX)) return []
      const presetId = readRecord(rule.values?.['chat.preset'])?.preset
      return typeof presetId === 'string' ? [{ botId: rule.id.slice(RULE_PREFIX.length), presetId, ruleId: rule.id }] : []
    })
  }

  list() {
    const presets = this.presets()
    return {
      presets: presets.list().map((record) => this.summarize(record)),
      loaders: presets.listLoaders().map((loader) => ({ id: loader.id, extensions: [...loader.extensions] })),
      assignments: this.assignments(),
    }
  }

  async get(id: string) {
    const record = this.require(id)
    const source = await this.presets().source(id)
    // 插件贡献的预设没有源文件，给出解析后的数据，测试者仍能看到它渲染出什么。
    return { preset: this.summarize(record), ...(source ? { source } : { data: record.data }) }
  }

  async create(input: { id: string; loader?: string; text?: string; copyFrom?: string }) {
    if (!isTestPresetId(input.id)) {
      throw new SandboxChatLunaError('forbidden', `测试预设的 ID 必须以 ${TEST_PRESET_PREFIX} 开头：${input.id}`)
    }
    const presets = this.presets()
    if (input.copyFrom !== undefined) {
      this.require(input.copyFrom)
      return this.summarize(await guarded(() => presets.duplicate(input.copyFrom!, input.id, RULE_WRITER)))
    }
    if (input.loader === undefined) throw new SandboxChatLunaError('invalid', 'loader 与 copyFrom 至少需要提供一项')
    const loader = input.loader
    return this.summarize(await guarded(() => presets.create({ id: input.id, loader, ...(input.text === undefined ? {} : { text: input.text }) }, RULE_WRITER)))
  }

  async save(id: string, text: string, revision: string) {
    const record = this.require(id)
    if (!this.writable(record)) {
      throw new SandboxChatLunaError('forbidden', record.editable !== 'source'
        ? `预设 ${id} 由插件提供，只读`
        : `预设 ${id} 不是测试预设，也不在插件设置的可编辑预设列表里`)
    }
    return this.summarize(await guarded(() => this.presets().save(id, text, revision, RULE_WRITER)))
  }

  async remove(id: string, revision?: string) {
    this.require(id)
    if (!isTestPresetId(id)) throw new SandboxChatLunaError('forbidden', `只能删除测试预设（${TEST_PRESET_PREFIX} 开头）：${id}`)
    // 先撤掉指向它的切换规则：规则留着而预设没了，机器人下一次回复就会因找不到预设而失败。
    const unassignedBots: string[] = []
    for (const assignment of this.assignments().filter((item) => item.presetId === id)) {
      await this.assign(assignment.botId, undefined)
      unassignedBots.push(assignment.botId)
    }
    await guarded(() => this.presets().remove(id, revision, RULE_WRITER))
    return { removed: id, unassignedBots }
  }

  async assign(botId: string, presetId: string | undefined) {
    const routing = this.routing()
    const ruleId = `${RULE_PREFIX}${botId}`
    if (presetId === undefined) {
      if (routing.rule(ruleId)) await guarded(() => routing.remove(ruleId, { by: RULE_WRITER }))
      return { botId, presetId: null }
    }
    this.require(presetId)
    await guarded(() => routing.save({
      id: ruleId,
      name: `OneBot 沙盒：机器人 ${botId} 的预设`,
      filter: {
        kind: 'and',
        operands: [
          { kind: 'scope', field: 'platform', values: [PLATFORM] },
          { kind: 'scope', field: 'self', values: [botId] },
        ],
      },
      values: { 'chat.preset': { preset: presetId } },
      enabled: true,
      by: RULE_WRITER,
    }, { by: RULE_WRITER }))
    return { botId, presetId, ruleId }
  }
}

/** 设置页「可编辑预设」的动态 schema 名，`src/index.ts` 的字段经 `Schema.dynamic` 引用它。 */
export const EDITABLE_PRESETS_SCHEMA = 'onebot-sandbox.editable-presets'

/**
 * 「可编辑预设」的可选项：v2 里能按源文本编辑、又不是测试预设的预设。
 *
 * 测试预设总是可写，插件提供的预设总是只读，两者列出来勾了也不改变什么，所以不进选项。已经登记、
 * 但预设已经不在的 ID 仍然列出并标明，否则多选控件会把它当成未知值悄悄丢掉，用户也无从取消。
 */
export function editablePresetChoices(presets: readonly { id: string; name: string; editable: string }[], selected: readonly string[]): Schema {
  const candidates = presets.filter((preset) => preset.editable === 'source' && !isTestPresetId(preset.id))
  const known = new Set(candidates.map(({ id }) => id))
  const choices = [
    ...candidates.map((preset) => Schema.const(preset.id).description(preset.name === preset.id ? preset.id : `${preset.name}（${preset.id}）`)),
    ...selected.filter((id) => !known.has(id)).map((id) => Schema.const(id).description(`${id}（预设已不存在）`)),
  ]
  return Schema.array(Schema.union(choices)).role('select')
}

function readSelected(doc: Record<string, unknown>): string[] {
  const value = readRecord(doc.presetEditing)?.editablePresets
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * 登记「可编辑预设」的选项来源。设置页按需向服务端解析，预设增删时让已打开的设置页重新解析。
 *
 * `schemas` 只在这一处子作用域里注入，`presets` 按名称现取，理由同 `findChatLunaRuntime`：
 * 写进插件的 `inject` 会让被测插件每次重载都连带重建沙盒。
 */
export function registerEditablePresetChoices(ctx: Context): void {
  ctx.inject(['schemas'], (inner) => {
    inner.schemas.define(EDITABLE_PRESETS_SCHEMA, ({ doc }) => {
      const presets = findChatLunaRuntime(ctx, 'presets', (service) => (typeof service.list === 'function' ? service : undefined))
      const records = presets ? (presets.list as () => PresetRecordLike[]).call(presets) : []
      return editablePresetChoices(records, readSelected(doc))
    })
    inner.on('presets/change', () => inner.schemas.invalidate(EDITABLE_PRESETS_SCHEMA))
  })
}
