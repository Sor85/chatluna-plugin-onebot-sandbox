import { describe, expect, it } from 'vitest'
import { projectModelEvidence } from '../src/model-evidence'
import {
  matchPresetExpressionEvidence,
  parsePresetSourceDocument,
  type PresetRuntimeSnapshot,
} from '../src/presets'

function coreSnapshot(source: string): PresetRuntimeSnapshot {
  const document = parsePresetSourceDocument('core', source)
  return {
    kind: 'core',
    presetName: 'demo',
    capturedAt: '2026-01-01T00:00:00.000Z',
    source,
    templates: document.templateFields.map((field) => ({
      path: field.path,
      role: field.path[0] === 'format_user_prompt'
        ? 'user'
        : source.includes('role: assistant', Math.max(0, field.range.start - 80)) ? 'assistant' : 'system',
      template: field.value,
    })),
  }
}

function expression(source: string, content: string, ordinal = 0) {
  const matches = parsePresetSourceDocument('core', source).expressions.filter((item) => item.content === content)
  const found = matches[ordinal]
  if (!found) throw new Error(`missing expression ${content}#${ordinal}`)
  return found
}

describe('预设表达式模型证据匹配', () => {
  it('按角色、字面锚点和表达式序号定位重复变量，而不按展开值全局搜索', () => {
    const source = `name: demo
prompts:
  - role: system
    content: "First [{name}] middle [{name}] end"
`
    const snapshot = coreSnapshot(source)
    const evidence = projectModelEvidence({ requestBody: {
      messages: [
        { role: 'user', content: 'unrelated Alice value' },
        { role: 'system', content: 'First [Alice] middle [Alice] end' },
      ],
    } })

    expect(matchPresetExpressionEvidence({
      document: parsePresetSourceDocument('core', source),
      expression: expression(source, 'name', 1),
      snapshot,
      evidence,
    })).toEqual({
      status: 'matched',
      evidenceId: 'req:message:messages.1',
      range: { start: 22, end: 27 },
    })
  })

  it('支持连续表达式和空输出，并拒绝不能唯一切分的相邻表达式', () => {
    const source = `prompts:
  - role: system
    content: "A{left}{right}Z"
`
    const document = parsePresetSourceDocument('core', source)
    const snapshot = coreSnapshot(source)

    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'left'),
      snapshot,
      evidence: projectModelEvidence({ requestBody: { messages: [{ role: 'system', content: 'AZ' }] } }),
    })).toMatchObject({ status: 'matched', range: { start: 1, end: 1 } })

    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'left'),
      snapshot,
      evidence: projectModelEvidence({ requestBody: { messages: [{ role: 'system', content: 'AxyZ' }] } }),
    })).toEqual({ status: 'ambiguous' })
  })

  it('可定位实际执行的 if/else 分支内值表达式，控制标签仍不支持点击', () => {
    const source = `prompts:
  - role: system
    content: "Start {if primary}P[{primaryValue}]{elseif secondary}S[{secondaryValue}]{else}F[{fallbackValue}]{/if} End"
`
    const document = parsePresetSourceDocument('core', source)
    const snapshot = coreSnapshot(source)
    const evidence = projectModelEvidence({ requestBody: {
      messages: [{ role: 'system', content: 'Start S[chosen] End' }],
    } })

    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'secondaryValue'),
      snapshot,
      evidence,
    })).toMatchObject({ status: 'matched', range: { start: 8, end: 14 } })
    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'primaryValue'),
      snapshot,
      evidence,
    })).toEqual({ status: 'not-observed' })
    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'fallbackValue'),
      snapshot,
      evidence: projectModelEvidence({ requestBody: {
        messages: [{ role: 'system', content: 'Start F[fallback] End' }],
      } }),
    })).toMatchObject({ status: 'matched', range: { start: 8, end: 16 } })
    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'if primary'),
      snapshot,
      evidence,
    })).toEqual({ status: 'unsupported', reason: 'control-tag' })
  })

  it('不同分支可产生同一观察文本时不猜测目标表达式是否执行', () => {
    const source = `prompts:
  - role: system
    content: "{if primary}[{value}]{else}[]{/if}"
`
    const document = parsePresetSourceDocument('core', source)
    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'value'),
      snapshot: coreSnapshot(source),
      evidence: projectModelEvidence({ requestBody: {
        messages: [{ role: 'system', content: '[]' }],
      } }),
    })).toEqual({ status: 'ambiguous' })
  })

  it('循环体重复导致同一值表达式有多个精确范围时返回 ambiguous，省略时返回 not-observed', () => {
    const source = `prompts:
  - role: system
    content: "Items:{for item in items}[{item}]{/for}:done"
`
    const document = parsePresetSourceDocument('core', source)
    const snapshot = coreSnapshot(source)

    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'item'),
      snapshot,
      evidence: projectModelEvidence({ requestBody: {
        messages: [{ role: 'system', content: 'Items:[A][B]:done' }],
      } }),
    })).toEqual({ status: 'ambiguous' })

    expect(matchPresetExpressionEvidence({
      document,
      expression: expression(source, 'item'),
      snapshot,
      evidence: projectModelEvidence({ requestBody: {
        messages: [{ role: 'system', content: 'Items::done' }],
      } }),
    })).toEqual({ status: 'not-observed' })
  })

  it('跨 OpenAI 与 Gemini 投影返回对应请求消息 evidenceId', () => {
    const source = `prompts:
  - role: system
    content: "System <{name}>."
`
    const input = {
      document: parsePresetSourceDocument('core', source),
      expression: expression(source, 'name'),
      snapshot: coreSnapshot(source),
    }

    expect(matchPresetExpressionEvidence({
      ...input,
      evidence: projectModelEvidence({ requestBody: { messages: [{ role: 'system', content: 'System <Alice>.' }] } }),
    })).toMatchObject({ status: 'matched', evidenceId: 'req:message:messages.0', range: { start: 8, end: 13 } })

    expect(matchPresetExpressionEvidence({
      ...input,
      evidence: projectModelEvidence({ requestBody: {
        systemInstruction: { parts: [{ text: 'System <Alice>.' }] },
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      } }),
    })).toMatchObject({ status: 'matched', evidenceId: 'req:message:systemInstruction.parts.0', range: { start: 8, end: 13 } })
  })

  it('返回 stale、not-observed、ambiguous 与 unsupported，而不伪造精确跳转', () => {
    const source = `prompts:
  - role: system
    content: "Hello {name}!"
`
    const document = parsePresetSourceDocument('core', source)
    const valueExpression = expression(source, 'name')
    const snapshot = coreSnapshot(source)

    expect(matchPresetExpressionEvidence({
      document: parsePresetSourceDocument('core', source.replace('Hello', 'Hi')),
      expression: valueExpression,
      snapshot,
      evidence: projectModelEvidence({ requestBody: { messages: [{ role: 'system', content: 'Hello Alice!' }] } }),
    })).toEqual({ status: 'stale' })

    expect(matchPresetExpressionEvidence({
      document,
      expression: valueExpression,
      snapshot,
      evidence: projectModelEvidence({ requestBody: { messages: [{ role: 'user', content: 'Hello Alice!' }] } }),
    })).toEqual({ status: 'not-observed' })

    expect(matchPresetExpressionEvidence({
      document,
      expression: valueExpression,
      snapshot,
      evidence: projectModelEvidence({ requestBody: { messages: [
        { role: 'system', content: 'Hello Alice!' },
        { role: 'system', content: 'Hello Bob!' },
      ] } }),
    })).toEqual({ status: 'ambiguous' })

    const controlSource = `prompts:\n  - role: system\n    content: "{if ok}yes{/if}"\n`
    const controlDocument = parsePresetSourceDocument('core', controlSource)
    expect(matchPresetExpressionEvidence({
      document: controlDocument,
      expression: controlDocument.expressions[0]!,
      snapshot: coreSnapshot(controlSource),
      evidence: projectModelEvidence({ requestBody: { messages: [{ role: 'system', content: 'yes' }] } }),
    })).toEqual({ status: 'unsupported', reason: 'control-tag' })
  })
})
