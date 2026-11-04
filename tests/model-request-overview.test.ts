import { describe, expect, it } from 'vitest'
import {
  buildModelRequestEntityChips,
  buildModelRequestUsageCells,
  formatModelRequestChannelName,
  formatModelRequestCount,
  formatModelRequestLabel,
  formatModelRequestModelName,
  formatModelRequestOrdinal,
  formatModelRequestSource,
  formatModelRequestTokenCount,
  formatModelRequestTokenRate,
} from '../client/model-request/overview'

describe('模型请求概览取词', () => {
  it('模型 ID 与渠道采集到就照原样显示，空串与缺省都算没识别出来', () => {
    expect(formatModelRequestModelName('gpt-4.1')).toBe('gpt-4.1')
    expect(formatModelRequestModelName('')).toBe('未识别')
    expect(formatModelRequestModelName(undefined)).toBe('未识别')
    expect(formatModelRequestChannelName('openai')).toBe('openai')
    expect(formatModelRequestChannelName('')).toBe('未识别')
    expect(formatModelRequestChannelName(undefined)).toBe('未识别')
  })

  it('模型请求来源只显示主插件或 character，无法唯一判断时显示未识别', () => {
    expect(formatModelRequestSource({ presetSnapshotSummaries: [{ kind: 'core', presetName: 'demo', capturedAt: '', templateCount: 1 }] })).toBe('主插件')
    expect(formatModelRequestSource({ presetSnapshotSummaries: [{ kind: 'character', presetName: 'alice', capturedAt: '', templateCount: 1 }] })).toBe('character')
    expect(formatModelRequestSource({ presetSnapshotSummaries: [] })).toBe('未识别')
    expect(formatModelRequestSource({ presetSnapshots: [{ kind: 'core', presetName: 'demo', capturedAt: '', templates: [] }] })).toBe('主插件')
    expect(formatModelRequestSource(undefined)).toBe('未识别')
  })

  it('计数格把 0 当事实显示，只有整项缺省才退到缺省符号', () => {
    expect(formatModelRequestCount(12)).toBe('12')
    expect(formatModelRequestCount(0)).toBe('0')
    expect(formatModelRequestCount(undefined)).toBe('—')
  })

  it('请求标签拼渠道与模型，两者都缺时退回通称而不是半截标签', () => {
    expect(formatModelRequestLabel({ provider: 'openai', model: 'gpt-4.1' })).toBe('openai / gpt-4.1')
    expect(formatModelRequestLabel({ model: 'gpt-4.1' })).toBe('gpt-4.1')
    expect(formatModelRequestLabel({ provider: 'openai' })).toBe('openai')
    expect(formatModelRequestLabel({})).toBe('模型请求')
    expect(formatModelRequestLabel(undefined)).toBe('模型请求')
  })

  it('请求序号按下标加一，找不到下标时不编号', () => {
    expect(formatModelRequestOrdinal(0)).toBe('请求 1')
    expect(formatModelRequestOrdinal(4)).toBe('请求 5')
    expect(formatModelRequestOrdinal(undefined)).toBe('请求')
  })

  it('Token 计数千分位、速率保留两位小数，非有限值退到缺省符号', () => {
    expect(formatModelRequestTokenCount(1234567)).toBe('1,234,567')
    expect(formatModelRequestTokenCount(0)).toBe('0')
    expect(formatModelRequestTokenCount(undefined)).toBe('—')
    expect(formatModelRequestTokenRate(41.256)).toBe('41.26 /s')
    expect(formatModelRequestTokenRate(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatModelRequestTokenRate(undefined)).toBe('—')
  })

  it('用量格八项按 Token、合计、速度、耗时的顺序给出，缺项各自退到缺省符号', () => {
    expect(buildModelRequestUsageCells({
      source: 'chatluna-usage',
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      ttftMs: 820,
      tps: 41.256,
      totalMs: 9400,
    })).toEqual([
      { label: '输入', value: '1,200' },
      { label: '输出', value: '340' },
      { label: '推理', value: '—' },
      { label: '缓存', value: '—' },
      { label: '总 Token', value: '1,540' },
      { label: 'TTFT', value: '820 ms' },
      { label: 'TPS', value: '41.26 /s' },
      { label: '总耗时', value: '9.4 s' },
    ])
  })

  it('没有用量时八项仍然齐全，全部显示缺省符号', () => {
    const cells = buildModelRequestUsageCells(undefined)
    expect(cells.map(({ label }) => label)).toEqual(['输入', '输出', '推理', '缓存', '总 Token', 'TTFT', 'TPS', '总耗时'])
    expect(cells.every(({ value }) => value === '—')).toBe(true)
  })

  it('关联实体按记录域、机器人、会话由外到内排，不跟着采集时的赋值顺序走', () => {
    // 键顺序刻意打乱成采集顺序，输出必须仍按展示契约排列。
    expect(buildModelRequestEntityChips({
      conversationId: '20002',
      botId: '10001',
      scopeId: 'main',
    })).toEqual([
      { key: 'scopeId', label: '记录域', value: 'main' },
      { key: 'botId', label: '机器人 ID', value: '10001' },
      { key: 'conversationId', label: '会话 ID', value: '20002' },
    ])
  })

  it('空串与缺省的字段不占标签，未归属记录没有关联实体', () => {
    expect(buildModelRequestEntityChips({ scopeId: '', botId: '10001' })).toEqual([
      { key: 'botId', label: '机器人 ID', value: '10001' },
    ])
    expect(buildModelRequestEntityChips({})).toEqual([])
  })
})
