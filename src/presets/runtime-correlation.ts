import type { Context } from 'cordis'
import { identifyCharacterTurnSession } from '../chatluna/character-turn-session'
import { parsePresetSourceDocument } from './source-document'
import type {
  PresetRuntimeResolvedTarget,
  PresetRuntimeSessionTarget,
  PresetRuntimeSnapshot,
  PresetRuntimeTemplate,
  PresetSourcePath,
  PresetTemplateRole,
} from './types'

export type ResolvePresetRuntimeTarget = (target: PresetRuntimeSessionTarget) => PresetRuntimeResolvedTarget | undefined

interface CorePresetLike {
  rawText?: unknown
  messages?: unknown
  formatUserPromptString?: unknown
}

interface CharacterPresetLike {
  name?: unknown
  system?: { rawString?: unknown }
  input?: { rawString?: unknown }
}

interface ActiveTurn {
  target: PresetRuntimeResolvedTarget
  turnId: string
  snapshot: PresetRuntimeSnapshot
}

interface PresetRuntimeEventRegistrar {
  (event: 'chatluna/before-chat', listener: (
    conversationId: string,
    message: unknown,
    variables: unknown,
    chatInterface: unknown,
    session: unknown,
  ) => void): () => void
  (event: 'chatluna/after-chat', listener: (
    conversationId: string,
    sourceMessage: unknown,
    responseMessage: unknown,
    variables: unknown,
    chatInterface: unknown,
    session: unknown,
  ) => void): () => void
  (event: 'chatluna/after-chat-error', listener: (error: unknown, conversationId: string) => void): () => void
  (event: 'chatluna_character/before-chat', listener: (payload: unknown) => void): () => void
  (event: 'chatluna_character/after-chat', listener: (payload: unknown) => void): () => void
}

export class PresetRuntimeSnapshotTracker {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly coreTurnKeys = new Map<string, Set<string>>()
  private readonly characterSessionTurnKeys = new WeakMap<object, Set<string>>()
  private readonly disposers: Array<() => void> = []
  private nextCoreTurn = 1
  private nextCharacterTurn = 1

  constructor(private ctx: Context, private resolveTarget: ResolvePresetRuntimeTarget) {
    const on = ctx.on.bind(ctx) as unknown as PresetRuntimeEventRegistrar
    this.disposers.push(on('chatluna/before-chat', (conversationId, _message, variables, chatInterface, session) => {
      const target = this.resolveSession(session)
      const presetName = readNestedString(variables, ['built', 'preset'])
      if (!target || !presetName) return
      const preset = resolveCorePreset(chatInterface, this.ctx, presetName)
      if (!preset) return
      const snapshot = snapshotCorePreset(presetName, preset)
      if (!snapshot) return
      const turnId = `core:${conversationId}`
      const key = activeKey(target, `${turnId}:${this.nextCoreTurn++}`)
      this.active.set(key, { target, turnId, snapshot })
      const keys = this.coreTurnKeys.get(conversationId) ?? new Set<string>()
      keys.add(key)
      this.coreTurnKeys.set(conversationId, keys)
    }))
    this.disposers.push(on('chatluna/after-chat', (conversationId, _sourceMessage, _responseMessage, _variables, _chatInterface, session) => {
      this.finishCore(conversationId, this.resolveSession(session))
    }))
    this.disposers.push(on('chatluna/after-chat-error', (_error, conversationId) => this.finishCore(conversationId)))
    this.disposers.push(on('chatluna_character/before-chat', (payload) => {
      const record = readRecord(payload)
      const target = this.resolveSession(record?.session)
      const preset = readRecord(record?.preset) as CharacterPresetLike | undefined
      const presetName = readString(record?.presetName) ?? readString(preset?.name)
      if (!target || !preset || !presetName) return
      const snapshot = snapshotCharacterPreset(presetName, preset)
      if (!snapshot) return
      const turnId = `character:${this.nextCharacterTurn++}`
      const key = activeKey(target, turnId)
      this.active.set(key, { target, turnId, snapshot })
      const identity = identifyCharacterTurnSession(record?.session)
      if (identity) {
        const keys = this.characterSessionTurnKeys.get(identity) ?? new Set<string>()
        keys.add(key)
        this.characterSessionTurnKeys.set(identity, keys)
      }
    }))
    this.disposers.push(on('chatluna_character/after-chat', (payload) => {
      this.finishCharacterTurn(readRecord(payload)?.session)
    }))
  }

  finishCharacterTurn(session: unknown): void {
    const identity = identifyCharacterTurnSession(session)
    if (!identity) return
    const sessionKeys = this.characterSessionTurnKeys.get(identity)
    // 同一 Session 出现多个并发 before-chat 时无法证明 release 对应哪一轮，继续保守保留而不是猜测。
    if (sessionKeys?.size !== 1) return
    const [key] = sessionKeys
    if (key) this.active.delete(key)
    this.characterSessionTurnKeys.delete(identity)
  }

  getActiveSnapshots(target: PresetRuntimeResolvedTarget): PresetRuntimeSnapshot[] {
    const turns = [...this.active.values()].filter((turn) => sameTarget(turn.target, target))
    const snapshots = (['core', 'character'] as const).flatMap((kind) => {
      const matchingKind = turns.filter((turn) => turn.snapshot.kind === kind)
      return matchingKind.length === 1 ? [matchingKind[0]!.snapshot] : []
    })
    return structuredClone(snapshots)
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.active.clear()
    this.coreTurnKeys.clear()
  }

  private resolveSession(session: unknown): PresetRuntimeResolvedTarget | undefined {
    const record = readRecord(session)
    const bot = readRecord(record?.bot)
    const channel = readRecord(record?.channel)
    const botId = readString(record?.selfId) ?? readString(bot?.selfId)
    const conversationId = readString(record?.channelId) ?? readString(channel?.id)
    return botId && conversationId ? this.resolveTarget({ botId, conversationId }) : undefined
  }

  private finishCore(conversationId: string, target?: PresetRuntimeResolvedTarget): void {
    const keys = this.coreTurnKeys.get(conversationId)
    if (!keys) return
    const matches = [...keys].filter((key) => {
      const turn = this.active.get(key)
      return turn && (!target || sameTarget(turn.target, target))
    })
    if (matches.length !== 1) return
    this.active.delete(matches[0]!)
    keys.delete(matches[0]!)
    if (!keys.size) this.coreTurnKeys.delete(conversationId)
  }
}

function snapshotCorePreset(presetName: string, preset: CorePresetLike): PresetRuntimeSnapshot | undefined {
  const templates = coreTemplates(preset)
  if (!templates.length) return
  return structuredClone({
    kind: 'core',
    presetName,
    capturedAt: new Date().toISOString(),
    ...(typeof preset.rawText === 'string' ? { source: preset.rawText } : {}),
    templates,
  })
}

function coreTemplates(preset: CorePresetLike): PresetRuntimeTemplate[] {
  if (typeof preset.rawText === 'string') {
    const document = parsePresetSourceDocument('core', preset.rawText)
    if (!document.diagnostics.length) {
      const templates: PresetRuntimeTemplate[] = document.templateFields.flatMap((field) => {
        const role = coreRoleForPath(preset, field.path)
        return role ? [{ path: field.path, role, template: field.value }] : []
      })
      if (typeof preset.formatUserPromptString === 'string'
        && !templates.some(({ path }) => path[0] === 'format_user_prompt')) {
        templates.push({ path: ['format_user_prompt'], role: 'user', template: preset.formatUserPromptString })
      }
      return templates
    }
  }
  const messages = Array.isArray(preset.messages) ? preset.messages : []
  const result: PresetRuntimeTemplate[] = messages.flatMap((message, index) => {
    const record = readRecord(message)
    const content = readMessageContent(record?.content)
    const role = readMessageRole(message)
    return content !== undefined && role
      ? [{ path: ['prompts', index, 'content'] as const, role, template: content }]
      : []
  })
  if (typeof preset.formatUserPromptString === 'string') {
    result.push({ path: ['format_user_prompt'], role: 'user', template: preset.formatUserPromptString })
  }
  return result
}

function coreRoleForPath(preset: CorePresetLike, path: PresetSourcePath): PresetTemplateRole | undefined {
  if (path[0] === 'format_user_prompt') return 'user'
  const index = typeof path[1] === 'number' ? path[1] : undefined
  return index === undefined ? undefined : readMessageRole(Array.isArray(preset.messages) ? preset.messages[index] : undefined)
}

function readMessageRole(message: unknown): PresetTemplateRole | undefined {
  const record = readRecord(message)
  const direct = readString(record?.role)?.toLowerCase()
  let type = direct
  const getType = record?._getType
  if (!type && typeof getType === 'function') {
    try { type = readString(getType.call(message))?.toLowerCase() } catch {}
  }
  if (type === 'system' || type === 'developer') return 'system'
  if (type === 'human' || type === 'user') return 'user'
  if (type === 'ai' || type === 'assistant') return 'assistant'
  if (type === 'tool' || type === 'function') return 'tool'
}

function readMessageContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const record = readRecord(value)
  return readString(record?.text)
}

function snapshotCharacterPreset(presetName: string, preset: CharacterPresetLike): PresetRuntimeSnapshot | undefined {
  const system = typeof preset.system?.rawString === 'string' ? preset.system.rawString : undefined
  const input = typeof preset.input?.rawString === 'string' ? preset.input.rawString : undefined
  if (system === undefined && input === undefined) return
  const templates: PresetRuntimeTemplate[] = []
  if (system !== undefined) templates.push({ path: ['system'], role: 'system', template: system })
  if (input !== undefined) templates.push({ path: ['input'], role: 'user', template: input })
  return structuredClone({
    kind: 'character',
    presetName,
    capturedAt: new Date().toISOString(),
    source: [system === undefined ? undefined : `system: ${system}`, input === undefined ? undefined : `input: ${input}`].filter(Boolean).join('\n'),
    templates,
  })
}

function resolveCorePreset(chatInterface: unknown, ctx: Context, presetName: string): CorePresetLike | undefined {
  const interfaceContext = readRecord(readRecord(chatInterface)?.ctx)
  const candidates = [readRecord(interfaceContext?.chatluna), readRecord(readRecord(ctx as unknown)?.chatluna)]
  for (const chatluna of candidates) {
    const service = readRecord(chatluna?.preset)
    const getPreset = service?.getPreset
    if (typeof getPreset !== 'function') continue
    try {
      const computed = getPreset.call(service, presetName, false)
      const value = readRecord(readRecord(computed)?.value)
      if (value) return value as CorePresetLike
    } catch {}
  }
}

function activeKey(target: PresetRuntimeResolvedTarget, turnId: string): string {
  return `${target.scopeId}\u0000${target.botId}\u0000${target.conversationId}\u0000${turnId}`
}

function sameTarget(left: PresetRuntimeResolvedTarget, right: PresetRuntimeResolvedTarget): boolean {
  return left.scopeId === right.scopeId && left.botId === right.botId && left.conversationId === right.conversationId
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value
  for (const key of path) current = readRecord(current)?.[key]
  return readString(current)
}
