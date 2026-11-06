import { describe, expect, it } from 'vitest'
import { parseThinkContent, readStepThought } from '../src/chatluna/thinking'

describe('角色内心活动', () => {
  it('从多个 think 标签中按顺序取出思考内容', () => {
    expect(parseThinkContent('<think> 第一段 </think>回复<think>第二段</think>')).toBe('第一段\n\n第二段')
  })

  it('没有 think 标签时返回空字符串', () => {
    expect(parseThinkContent('普通回复')).toBe('')
  })

  it('文本模式：从 step 的文本块里取 character 引擎写下的 <think>', () => {
    expect(readStepThought({
      content: [
        { type: 'reasoning', text: '模型原生推理不算内心活动' },
        { type: 'text', text: '<think>他今天好像很累</think><message>早点休息</message>' },
      ],
      toolCalls: [],
    })).toBe('他今天好像很累')
  })

  it('工具模式：从 reply 工具的 content 参数里取，其他工具的参数不算', () => {
    expect(readStepThought({
      content: [],
      toolCalls: [
        { type: 'tool-call', toolName: 'memory_write', input: { content: '<think>不该读到</think>' } },
        { type: 'tool-call', toolName: 'reply', input: { content: '<think>先安慰一下</think>没事的' } },
      ],
    })).toBe('先安慰一下')
  })

  it('形状不对时返回空字符串，而不是抛错', () => {
    expect(readStepThought(undefined)).toBe('')
    expect(readStepThought({ content: 'text', toolCalls: {} })).toBe('')
    expect(readStepThought({ content: [null, { type: 'text' }], toolCalls: [{ type: 'tool-call', toolName: 'reply' }] })).toBe('')
  })
})
