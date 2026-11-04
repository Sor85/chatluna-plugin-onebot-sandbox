import { describe, expect, it } from 'vitest'
import {
  EMPTY_MODEL_EVIDENCE_FILTER,
  MODEL_EVIDENCE_FILTER_KINDS,
  isEvidenceVisible,
  isModelEvidenceFilterActive,
  modelEvidenceFilterSummary,
  toggleFilterMember,
  type ModelEvidenceFilter,
} from '../client/model-request/filter'
import { SANDBOX_EVIDENCE_KINDS, type SandboxEvidenceKind } from '../src/evidence-kind'

function filter(kinds: SandboxEvidenceKind[] = []): ModelEvidenceFilter {
  return { hiddenKinds: new Set(kinds) }
}

describe('模型证据显示过滤', () => {
  it('过滤开关取八种基础证据种类里的七种，不含模型响应', () => {
    expect(MODEL_EVIDENCE_FILTER_KINDS.map(({ kind }) => kind))
      .toEqual(SANDBOX_EVIDENCE_KINDS.filter(kind => kind !== 'response'))
    expect(MODEL_EVIDENCE_FILTER_KINDS.map(({ label }) => label))
      .toEqual(['SYSTEM', 'USER', 'ASSISTANT', 'VARIABLE', 'TOOL DEFS', 'TOOL CALL', 'TOOL RESULT'])
  })

  it('基础证据种类可直接用于过滤判定，不需要先翻译一次', () => {
    for (const kind of SANDBOX_EVIDENCE_KINDS) {
      expect(isEvidenceVisible(filter([kind]), kind), kind).toBe(false)
      expect(isEvidenceVisible(EMPTY_MODEL_EVIDENCE_FILTER, kind), kind).toBe(true)
    }
    // 三种工具证据各自是一档，隐藏其中一种不影响另外两种。
    expect(isEvidenceVisible(filter(['tool-definition']), 'tool-call')).toBe(true)
    expect(isEvidenceVisible(filter(['tool-definition']), 'tool-result')).toBe(true)
  })

  it('请求边界行不参与种类过滤，隐藏全部种类后仍能看出有哪些请求', () => {
    const everything = filter(MODEL_EVIDENCE_FILTER_KINDS.map(({ kind }) => kind))
    expect(isEvidenceVisible(everything, undefined)).toBe(true)
  })

  it('按种类隐藏证据，未隐藏的种类仍然显示', () => {
    expect(isEvidenceVisible(filter(['system']), 'system')).toBe(false)
    expect(isEvidenceVisible(filter(['system']), 'user')).toBe(true)
    expect(isEvidenceVisible(EMPTY_MODEL_EVIDENCE_FILTER, 'tool-call')).toBe(true)
  })

  it('过滤开关不暴露模型响应种类，响应分组不会被 ASSISTANT 连带隐藏', () => {
    expect(MODEL_EVIDENCE_FILTER_KINDS.some(({ kind }) => kind === 'response')).toBe(false)
    const everything = filter(MODEL_EVIDENCE_FILTER_KINDS.map(({ kind }) => kind))
    expect(isEvidenceVisible(everything, 'response')).toBe(true)
    expect(isEvidenceVisible(filter(['assistant']), 'response')).toBe(true)
    expect(isEvidenceVisible(filter(['tool-call']), 'response')).toBe(true)
  })

  it('切换过滤成员返回新集合，便于响应式识别变更', () => {
    const first = toggleFilterMember(new Set<SandboxEvidenceKind>(), 'system')
    expect([...first]).toEqual(['system'])
    const second = toggleFilterMember(first, 'user')
    expect([...second]).toEqual(['system', 'user'])
    expect(second).not.toBe(first)
    expect([...toggleFilterMember(second, 'system')]).toEqual(['user'])
  })

  it('过滤摘要说明当前隐藏了什么', () => {
    expect(isModelEvidenceFilterActive(EMPTY_MODEL_EVIDENCE_FILTER)).toBe(false)
    expect(modelEvidenceFilterSummary(EMPTY_MODEL_EVIDENCE_FILTER)).toBe('显示全部证据')
    const active = filter(['tool-definition', 'system'])
    expect(isModelEvidenceFilterActive(active)).toBe(true)
    // 摘要按选项声明顺序排列，不按用户点击顺序，避免同一组过滤读出不同文案。
    expect(modelEvidenceFilterSummary(active)).toBe('已隐藏 SYSTEM、TOOL DEFS')
  })
})
