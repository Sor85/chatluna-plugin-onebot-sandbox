import type {
  SandboxPresetRuntimeSnapshot,
  SandboxPresetRuntimeTemplate,
  SandboxPresetTemplateRole,
} from '../types'

export type PresetDocumentKind = 'core' | 'character'

export type PresetRuntimeSnapshot = SandboxPresetRuntimeSnapshot
export type PresetRuntimeTemplate = SandboxPresetRuntimeTemplate
export type PresetTemplateRole = SandboxPresetTemplateRole

export type PresetSourcePath = readonly (string | number)[]

export interface PresetSourceRange {
  start: number
  end: number
}

export type PresetTemplateExpressionKind = 'value' | 'control'

export interface PresetTemplateExpression {
  path: PresetSourcePath
  range: PresetSourceRange
  content: string
  kind: PresetTemplateExpressionKind
  clickable: boolean
  occurrence: number
}

export interface PresetTemplateField {
  path: PresetSourcePath
  range: PresetSourceRange
  value: string
}

export type PresetSourceDiagnosticCode =
  | 'yaml-parse-error'
  | 'template-field-not-string'

export interface PresetSourceDiagnostic {
  code: PresetSourceDiagnosticCode
  message: string
  severity: 'error'
  path?: PresetSourcePath
  range?: PresetSourceRange
}

export interface PresetSourceDocument {
  kind: PresetDocumentKind
  source: string
  displayName?: string
  templateFields: PresetTemplateField[]
  expressions: PresetTemplateExpression[]
  diagnostics: PresetSourceDiagnostic[]
}

export interface PresetRuntimeSessionTarget {
  botId: string
  conversationId: string
}

export interface PresetRuntimeResolvedTarget extends PresetRuntimeSessionTarget {
  scopeId: string
}

export type PresetEvidenceMatchResult =
  | { status: 'matched', evidenceId: string, range: PresetSourceRange }
  | { status: 'stale' }
  | { status: 'not-observed' }
  | { status: 'ambiguous' }
  | { status: 'unsupported', reason: 'control-tag' | 'template-field' }
