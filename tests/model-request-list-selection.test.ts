import { describe, expect, it } from 'vitest'
import {
  beginModelRequestListNavigation,
  clearModelRequestListSelection,
  resolveModelRequestListRecords,
  restoreModelRequestListSelection,
  selectModelRequestListRecord,
  type ModelRequestListSelectionState,
} from '../client/model-request/list-selection'
import type {
  SandboxModelRequestDetail,
  SandboxModelRequestListItem,
} from '../src/types'

function record(id: string): SandboxModelRequestListItem {
  return {
    id,
    sequence: 1,
    status: 'success',
    durationMs: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    attribution: 'attributed',
    entities: { scopeId: 'main' },
    requestBodyAvailable: true,
    responseBodyStatus: 'complete',
  }
}

function detail(id: string): SandboxModelRequestDetail {
  return { ...record(id), variables: [] } as SandboxModelRequestDetail
}

describe('模型请求列表选择', () => {
  it('详情先返回时把跨页跳转目标补入列表', () => {
    const state: ModelRequestListSelectionState = { selectedRecordId: '' }
    beginModelRequestListNavigation(state, 'request:target')

    expect(state.selectedRecordId).toBe('request:target')
    expect(resolveModelRequestListRecords(
      state,
      [record('request:latest')],
      detail('request:target'),
    ).map(({ id }) => id)).toEqual(['request:target', 'request:latest'])
    // 目标仍未进入列表，跨页补入的登记必须保留，下一批记录到达时继续生效。
    expect(state.navigationRecordId).toBe('request:target')
  })

  it('列表自己返回目标时结束跨页补入登记', () => {
    const state: ModelRequestListSelectionState = { selectedRecordId: '' }
    beginModelRequestListNavigation(state, 'request:target')

    expect(resolveModelRequestListRecords(state, [record('request:target')])).toHaveLength(1)
    expect(state).toEqual({
      selectedRecordId: 'request:target',
      navigationRecordId: undefined,
    })
  })

  it('清空选中同时丢弃跨页补入登记', () => {
    const state: ModelRequestListSelectionState = { selectedRecordId: '' }
    beginModelRequestListNavigation(state, 'request:target')

    clearModelRequestListSelection(state)

    expect(state).toEqual({ selectedRecordId: '', navigationRecordId: undefined })
    expect(resolveModelRequestListRecords(
      state,
      [record('request:latest')],
      detail('request:target'),
    ).map(({ id }) => id)).toEqual(['request:latest'])
  })

  it('工作台重新挂载时从已有详情恢复左侧选中记录', () => {
    const state: ModelRequestListSelectionState = { selectedRecordId: '' }

    restoreModelRequestListSelection(state, detail('request:target'))

    expect(state).toEqual({ selectedRecordId: 'request:target', navigationRecordId: undefined })
    expect(resolveModelRequestListRecords(
      state,
      [record('request:target'), record('request:other')],
    ).map(({ id }) => id)).toEqual(['request:target', 'request:other'])
  })

  it('恢复普通详情选择不会把记录误登记为跨页导航目标', () => {
    const state: ModelRequestListSelectionState = { selectedRecordId: '' }

    restoreModelRequestListSelection(state, detail('request:target'))

    expect(resolveModelRequestListRecords(
      state,
      [record('request:latest')],
      detail('request:target'),
    ).map(({ id }) => id)).toEqual(['request:latest'])
  })

  it('用户主动选择其他请求时取消待处理跳转', () => {
    const state: ModelRequestListSelectionState = { selectedRecordId: '' }
    beginModelRequestListNavigation(state, 'request:target')
    selectModelRequestListRecord(state, 'request:other')

    expect(state).toEqual({ selectedRecordId: 'request:other', navigationRecordId: undefined })
    expect(resolveModelRequestListRecords(
      state,
      [record('request:latest')],
      detail('request:target'),
    ).map(({ id }) => id)).toEqual(['request:latest'])
  })

  it('详情不是跳转目标时不补入列表', () => {
    const state: ModelRequestListSelectionState = { selectedRecordId: '' }
    beginModelRequestListNavigation(state, 'request:target')

    expect(resolveModelRequestListRecords(
      state,
      [record('request:latest')],
      detail('request:other'),
    ).map(({ id }) => id)).toEqual(['request:latest'])
  })
})
