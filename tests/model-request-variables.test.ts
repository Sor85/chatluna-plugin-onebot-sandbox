import { describe, expect, it } from 'vitest'
import { projectModelEvidence } from '../src/model-evidence'
import { deriveModelRequestVariables } from '../src/model-request-variables'
import type { SandboxPresetRuntimeSnapshot } from '../src/types'

function evidence(content: string) {
  return projectModelEvidence({ requestBody: { messages: [{ role: 'system', content }] } })
}

describe('模型请求变量', () => {
  it('只从运行时预设的值表达式派生变量名和本次请求观察值', () => {
    const snapshot: SandboxPresetRuntimeSnapshot = {
      kind: 'character',
      presetName: 'koishi',
      capturedAt: '2026-08-23T04:28:12.000Z',
      templates: [{
        path: ['system'],
        role: 'system',
        template: '时间：{time}，天气：{weather}，记忆：{long_memory("guild")}。',
      }],
    }

    expect(deriveModelRequestVariables([snapshot], evidence('时间：12:30，天气：晴，记忆：昨天一起散步。'))).toEqual([
      expect.objectContaining({ name: 'time', status: 'observed', value: '12:30' }),
      expect.objectContaining({ name: 'weather', status: 'observed', value: '晴' }),
      expect.objectContaining({ name: 'long_memory("guild")', status: 'observed', value: '昨天一起散步' }),
    ])
  })

  it('保留重复表达式的预设顺序，并在范围有歧义时不伪造变量值', () => {
    const snapshot: SandboxPresetRuntimeSnapshot = {
      kind: 'core',
      presetName: 'demo',
      capturedAt: '2026-08-23T04:28:12.000Z',
      templates: [{ path: ['prompts', 0, 'content'], role: 'system', template: 'A[{name}]B[{name}]C' }],
    }
    const variables = deriveModelRequestVariables([snapshot], evidence('A[Alice]B[Bob]C'))

    expect(variables.map(({ name, occurrence, value }) => ({ name, occurrence, value }))).toEqual([
      { name: 'name', occurrence: 0, value: 'Alice' },
      { name: 'name', occurrence: 1, value: 'Bob' },
    ])
  })

  it('控制标签不进入变量列表，未执行分支保留未观察状态', () => {
    const snapshot: SandboxPresetRuntimeSnapshot = {
      kind: 'character',
      presetName: 'demo',
      capturedAt: '2026-08-23T04:28:12.000Z',
      templates: [{ path: ['system'], role: 'system', template: '{if ok}值：{value}{else}备用：{fallback}{/if}' }],
    }
    const variables = deriveModelRequestVariables([snapshot], evidence('备用：离线'))

    expect(variables.map(({ name, status, value }) => ({ name, status, value }))).toEqual([
      { name: 'value', status: 'not-observed', value: undefined },
      { name: 'fallback', status: 'observed', value: '离线' },
    ])
  })

  it('投影没有请求消息时不产生观察值，只保留未观察状态', () => {
    const snapshot: SandboxPresetRuntimeSnapshot = {
      kind: 'character',
      presetName: 'demo',
      capturedAt: '2026-08-23T04:28:12.000Z',
      templates: [{ path: ['system'], role: 'system', template: '时间：{time}。' }],
    }
    const variables = deriveModelRequestVariables([snapshot], projectModelEvidence({ requestBody: 'not-an-object' }))

    expect(variables.map(({ name, status, value }) => ({ name, status, value }))).toEqual([
      { name: 'time', status: 'not-observed', value: undefined },
    ])
  })

  it('没有运行时预设快照时不产生变量', () => {
    expect(deriveModelRequestVariables([], evidence('时间：12:30。'))).toEqual([])
  })
})
