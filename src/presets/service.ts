import { resolve } from 'node:path'
import { projectModelEvidence } from '../model-evidence'
import { MAIN_MODEL_REQUEST_SCOPE_ID, type SandboxModelRequestStore } from '../model-request'
import type { SandboxModelRequestRecord, SandboxPresetRuntimeSnapshot } from '../types'
import { matchPresetExpressionEvidence } from './evidence-match'
import {
  FileSystemPresetRepository,
  PresetRepositoryError,
  type CreatePresetInput,
  type DeletePresetInput,
  type PresetFile,
  type PresetRepository,
  type RenamePresetInput,
  type SavePresetInput,
} from './repository'
import type {
  PresetDocumentKind,
  PresetSourceDiagnostic,
  PresetSourcePath,
  PresetSourceRange,
  PresetTemplateExpression,
  PresetTemplateField,
} from './types'

export interface SandboxPresetExpression extends PresetTemplateExpression {
  stableId: string
}

export interface SandboxPresetDocument {
  kind: PresetDocumentKind
  fileName: string
  displayName?: string
  source: string
  revision: string
  size: number
  modifiedAt: string
  templateFields: PresetTemplateField[]
  expressions: SandboxPresetExpression[]
  diagnostics: PresetSourceDiagnostic[]
}

export interface ReadSandboxPresetInput {
  kind: PresetDocumentKind
  fileName: string
}

export type SandboxPresetRequestScope =
  | { scope: 'main' }
  | { scope: 'space', spaceId: string }

export interface SandboxPresetDocumentIdentity extends ReadSandboxPresetInput {
  revision: string
}

export type SandboxPresetExpressionIdentity =
  | { stableId: string }
  | {
    path: PresetSourcePath
    range: PresetSourceRange
    occurrence: number
  }

export interface LocateSandboxPresetExpressionInput {
  document: SandboxPresetDocumentIdentity
  expression: SandboxPresetExpressionIdentity
  scope: SandboxPresetRequestScope
}

export type SandboxPresetLocateFailureCode =
  | 'invalid-scope'
  | 'scope-unavailable'
  | 'document-not-found'
  | 'document-stale'
  | 'document-identity-unavailable'
  | 'expression-not-found'
  | 'request-not-observed'
  | 'expression-stale'
  | 'expression-not-observed'
  | 'expression-ambiguous'
  | 'expression-unsupported'

export type LocateSandboxPresetExpressionResult =
  | {
    status: 'matched'
    recordId: string
    evidenceId: string
    range: PresetSourceRange
    scope: SandboxPresetRequestScope
  }
  | {
    status: 'failed'
    code: SandboxPresetLocateFailureCode
    message: string
    scope?: SandboxPresetRequestScope
    reason?: 'control-tag' | 'template-field'
  }

export interface SandboxPresetServiceOptions {
  baseDir: string
  mainModelRequests: SandboxModelRequestStore
  getTestSpaceModelRequests?: (spaceId: string) => SandboxModelRequestStore | undefined
  repository?: PresetRepository
}

export class SandboxPresetService {
  private readonly repository: PresetRepository

  constructor(private readonly options: SandboxPresetServiceOptions) {
    this.repository = options.repository ?? new FileSystemPresetRepository({
      coreRoot: resolve(options.baseDir, 'data/chathub/presets'),
      characterRoot: resolve(options.baseDir, 'data/chathub/character/presets'),
    })
  }

  async catalog(kind?: PresetDocumentKind): Promise<SandboxPresetDocument[]> {
    const kinds: PresetDocumentKind[] = kind ? [kind] : ['core', 'character']
    const files = await Promise.all(kinds.map((documentKind) => this.repository.readAll(documentKind)))
    return files.flat().map((file) => this.present(file)).sort((left, right) => (
      left.kind.localeCompare(right.kind)
      || left.displayName?.localeCompare(right.displayName ?? '')
      || left.fileName.localeCompare(right.fileName)
    ))
  }

  async read(input: ReadSandboxPresetInput): Promise<SandboxPresetDocument> {
    return this.present(await this.repository.read(input.kind, input.fileName))
  }

  async create(input: CreatePresetInput): Promise<SandboxPresetDocument> {
    return this.present(await this.repository.create(input))
  }

  async save(input: SavePresetInput): Promise<SandboxPresetDocument> {
    return this.present(await this.repository.save(input))
  }

  async rename(input: RenamePresetInput): Promise<SandboxPresetDocument> {
    return this.present(await this.repository.rename(input))
  }

  async delete(input: DeletePresetInput): Promise<{ deleted: true }> {
    await this.repository.delete(input)
    return { deleted: true }
  }

  async locateExpression(input: LocateSandboxPresetExpressionInput): Promise<LocateSandboxPresetExpressionResult> {
    const resolvedScope = this.resolveStore(input.scope)
    if ('failure' in resolvedScope) return resolvedScope.failure

    let document: SandboxPresetDocument
    try {
      document = await this.read(input.document)
    } catch (error) {
      if (error instanceof PresetRepositoryError && error.code === 'not-found') {
        return failure('document-not-found', error.message, input.scope)
      }
      throw error
    }
    if (document.revision !== input.document.revision) {
      return failure('document-stale', '预设源码 revision 已变化，请刷新后重试', input.scope)
    }
    if (!document.displayName) {
      return failure('document-identity-unavailable', '预设缺少可用于运行时关联的展示身份', input.scope)
    }
    const expression = resolveExpression(document.expressions, input.expression)
    if (!expression) return failure('expression-not-found', '预设表达式不存在或坐标已变化', input.scope)

    const recordAndSnapshot = await findLatestMatchingRequest(
      resolvedScope.store,
      resolvedScope.scopeId,
      document,
    )
    if (!recordAndSnapshot) {
      return failure('request-not-observed', '当前范围内没有使用该预设当前模板的有归属成功模型请求', input.scope)
    }

    const { record, snapshot } = recordAndSnapshot
    const result = matchPresetExpressionEvidence({
      document: {
        kind: document.kind,
        source: document.source,
        templateFields: document.templateFields,
        expressions: document.expressions,
        diagnostics: document.diagnostics,
      },
      expression,
      snapshot,
      evidence: projectModelEvidence({
        requestBody: record.requestBody,
        responseBodyRaw: record.responseBodyRaw,
        responseBodyFormat: record.responseBodyFormat,
      }),
    })
    if (result.status === 'matched') {
      return {
        status: 'matched',
        recordId: record.id,
        evidenceId: result.evidenceId,
        range: result.range,
        scope: input.scope,
      }
    }
    if (result.status === 'stale') return failure('expression-stale', '表达式或运行时模板已变化', input.scope)
    if (result.status === 'not-observed') return failure('expression-not-observed', '模型请求证据中未观察到该表达式的展开范围', input.scope)
    if (result.status === 'ambiguous') return failure('expression-ambiguous', '模型请求证据中存在多个可能范围，无法唯一定位', input.scope)
    return {
      ...failure('expression-unsupported', '该表达式不能映射为精确模型证据范围', input.scope),
      reason: result.reason,
    }
  }

  private present(file: PresetFile): SandboxPresetDocument {
    return {
      kind: file.kind,
      fileName: file.fileName,
      displayName: file.document.displayName,
      source: file.source,
      revision: file.revision,
      size: file.size,
      modifiedAt: file.modifiedAt,
      templateFields: structuredClone(file.document.templateFields),
      expressions: file.document.expressions.map((expression) => ({
        ...structuredClone(expression),
        stableId: expressionStableId(expression),
      })),
      diagnostics: structuredClone(file.document.diagnostics),
    }
  }

  private resolveStore(scope: SandboxPresetRequestScope):
    | { store: SandboxModelRequestStore, scopeId: string }
    | { failure: LocateSandboxPresetExpressionResult & { status: 'failed' } } {
    const raw = scope as { scope?: string, spaceId?: string }
    if (raw.scope === 'main' && !raw.spaceId) {
      return { store: this.options.mainModelRequests, scopeId: MAIN_MODEL_REQUEST_SCOPE_ID }
    }
    if (raw.scope === 'space' && raw.spaceId?.trim() && raw.spaceId !== MAIN_MODEL_REQUEST_SCOPE_ID) {
      const store = this.options.getTestSpaceModelRequests?.(raw.spaceId)
      return store
        ? { store, scopeId: raw.spaceId }
        : { failure: failure('scope-unavailable', `AI 测试空间模型请求库不可用：${raw.spaceId}`, scope) }
    }
    return { failure: failure('invalid-scope', '证据定位只接受 main 或一个明确的 AI 测试空间', undefined) }
  }
}

export function expressionStableId(expression: Pick<PresetTemplateExpression, 'path' | 'occurrence'>): string {
  return `${JSON.stringify(expression.path)}#${expression.occurrence}`
}

function resolveExpression(
  expressions: readonly SandboxPresetExpression[],
  identity: SandboxPresetExpressionIdentity,
): SandboxPresetExpression | undefined {
  if ('stableId' in identity) return expressions.find(({ stableId }) => stableId === identity.stableId)
  return expressions.find((expression) => (
    expression.occurrence === identity.occurrence
    && samePath(expression.path, identity.path)
    && expression.range.start === identity.range.start
    && expression.range.end === identity.range.end
  ))
}

async function findLatestMatchingRequest(
  store: SandboxModelRequestStore,
  scopeId: string,
  document: SandboxPresetDocument,
): Promise<{ record: SandboxModelRequestRecord, snapshot: SandboxPresetRuntimeSnapshot } | undefined> {
  let beforeSequence: number | undefined
  do {
    const page = await store.getRecords({ order: 'desc', limit: 200, beforeSequence })
    for (const item of page.records) {
      if (item.attribution !== 'attributed' || item.status !== 'success') continue
      if (item.entities.scopeId !== scopeId || !item.requestBodyAvailable) continue
      if (!item.presetSnapshotSummaries?.some((snapshot) => (
        snapshot.kind === document.kind && snapshot.presetName === document.displayName
      ))) continue
      const record = await store.getRecord(item.id)
      if (!record || record.requestBody === undefined) continue
      const snapshot = record.presetSnapshots?.find((candidate) => snapshotMatchesDocument(candidate, document))
      if (snapshot) return { record, snapshot }
    }
    beforeSequence = page.nextCursor
    if (!page.hasMore) return
  } while (beforeSequence !== undefined)
}

function snapshotMatchesDocument(snapshot: SandboxPresetRuntimeSnapshot, document: SandboxPresetDocument): boolean {
  if (snapshot.kind !== document.kind || snapshot.presetName !== document.displayName) return false
  if (snapshot.source === document.source) return true
  if (snapshot.templates.length !== document.templateFields.length) return false
  return document.templateFields.every((field) => snapshot.templates.some((template) => (
    samePath(template.path, field.path) && template.template === field.value
  )))
}

function samePath(left: PresetSourcePath, right: PresetSourcePath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function failure(
  code: SandboxPresetLocateFailureCode,
  message: string,
  scope?: SandboxPresetRequestScope,
): LocateSandboxPresetExpressionResult & { status: 'failed' } {
  return { status: 'failed', code, message, ...(scope ? { scope } : {}) }
}
