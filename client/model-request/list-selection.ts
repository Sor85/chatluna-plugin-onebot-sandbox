import type {
  SandboxModelRequestDetail,
  SandboxModelRequestListItem,
} from '../../src/types'

/**
 * 模型请求列表选择：普通选择，以及用权威详情把超出首屏分页的跳转目标补入列表。
 *
 * 「本次筛选变化不清空导航选中」这个一次性令牌属于证据导航 module，不在这里。
 */
export interface ModelRequestListSelectionState {
  selectedRecordId: string
  navigationRecordId?: string
}

export function beginModelRequestListNavigation(
  state: ModelRequestListSelectionState,
  recordId: string,
): void {
  state.selectedRecordId = recordId
  state.navigationRecordId = recordId
}

export function clearModelRequestListSelection(
  state: ModelRequestListSelectionState,
): void {
  state.selectedRecordId = ''
  state.navigationRecordId = undefined
}

export function selectModelRequestListRecord(
  state: ModelRequestListSelectionState,
  recordId: string,
): void {
  state.selectedRecordId = recordId
  state.navigationRecordId = undefined
}

/**
 * 工作台重新挂载时，详情仍由工作区控制器保留；用它恢复左侧的当前选择。
 * 不写入 navigationRecordId，避免普通页面返回被误当成跨页导航并重复补入记录。
 */
export function restoreModelRequestListSelection(
  state: ModelRequestListSelectionState,
  detail?: Pick<SandboxModelRequestDetail, 'id'>,
): void {
  if (!detail) return
  state.selectedRecordId = detail.id
  state.navigationRecordId = undefined
}

export function resolveModelRequestListRecords(
  state: ModelRequestListSelectionState,
  records: readonly SandboxModelRequestListItem[],
  detail?: SandboxModelRequestDetail,
): SandboxModelRequestListItem[] {
  const result = [...records]
  const navigationRecordId = state.navigationRecordId
  if (!navigationRecordId) return result
  if (result.some(({ id }) => id === navigationRecordId)) {
    state.navigationRecordId = undefined
    return result
  }
  if (detail?.id !== navigationRecordId) return result
  // 精确跳转的记录可能已超出首屏分页；用权威详情补入列表，确保左侧仍有可选中的请求。
  return [detail, ...result]
}
