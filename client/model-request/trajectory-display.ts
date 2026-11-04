import { isEvidenceVisible, toggleFilterMember } from './filter'
import type { SandboxEvidenceKind } from '../../src/evidence-kind'
import type { SandboxModelRequestTrajectoryRow } from '../../src/types'

export type ModelRequestTrajectorySortOrder = 'asc' | 'desc'

/**
 * 账本展示可以倒序请求，但每个请求内部必须保留服务端投影的阅读顺序。
 * 请求序号仍来自原始 records，排序只改变请求组的前后位置。
 */
export function orderModelRequestTrajectoryRows(
  rows: readonly SandboxModelRequestTrajectoryRow[],
  order: ModelRequestTrajectorySortOrder,
): SandboxModelRequestTrajectoryRow[] {
  const groups: SandboxModelRequestTrajectoryRow[][] = []
  const byRequestId = new Map<string, SandboxModelRequestTrajectoryRow[]>()
  for (const row of rows) {
    const requestId = row.requestId ?? row.id
    let group = byRequestId.get(requestId)
    if (!group) {
      group = []
      byRequestId.set(requestId, group)
      groups.push(group)
    }
    group.push(row)
  }
  return (order === 'desc' ? [...groups].reverse() : groups).flat()
}

export function isModelRequestTrajectoryRowCollapsed(
  row: Pick<SandboxModelRequestTrajectoryRow, 'kind' | 'requestId'>,
  collapsedRequestIds: ReadonlySet<string>,
): boolean {
  return row.kind !== 'request' && Boolean(row.requestId && collapsedRequestIds.has(row.requestId))
}

/**
 * 折叠或展开一个请求组。请求边界行没有 requestId 时什么都不做——原先这里少一个守卫
 * 就会把 undefined 塞进折叠集合，之后每一条同样没有 requestId 的行都被判成已折叠。
 */
export function toggleModelRequestTrajectoryCollapse(
  collapsedRequestIds: ReadonlySet<string>,
  requestId: string | undefined,
): ReadonlySet<string> {
  if (!requestId) return collapsedRequestIds
  return toggleFilterMember(collapsedRequestIds, requestId)
}

/**
 * 账本当前显示哪些行：全局折叠只留请求边界行，种类过滤按证据种类隐藏。
 *
 * 两条规则的交叉处有个容易丢的约定——请求边界行不参与种类过滤。它是请求本身而不是
 * 一条证据，若跟着被隐藏，把某个种类全关掉之后账本会连请求边界一起消失，看不出还有
 * 哪些请求可展开。
 */
export function filterModelRequestTrajectoryRows(input: {
  rows: readonly SandboxModelRequestTrajectoryRow[]
  requestsCollapsed: boolean
  hiddenKinds: ReadonlySet<SandboxEvidenceKind>
}): SandboxModelRequestTrajectoryRow[] {
  return input.rows.filter((row) => {
    if (input.requestsCollapsed && row.kind !== 'request') return false
    return isEvidenceVisible({ hiddenKinds: input.hiddenKinds }, row.kind === 'request' ? undefined : row.kind)
  })
}

/**
 * 每行的可搜索文本，按整份轨迹折叠一次。
 *
 * 这一步与静音判定必须分成两段，且分别由自己的依赖驱动：文本只随轨迹变化，静音只随
 * 查询变化。合成一段的话，输入一个字就要为每一行重新 toLocaleLowerCase 五个字段，
 * 搜索框在长会话里会明显卡手。
 */
export function buildModelRequestTrajectorySearchTexts(
  rows: readonly SandboxModelRequestTrajectoryRow[],
  describeRow: (row: SandboxModelRequestTrajectoryRow) => readonly (string | undefined)[],
): Map<string, string> {
  const texts = new Map<string, string>()
  for (const row of rows) {
    texts.set(row.id, describeRow(row).filter(Boolean).join('\n').toLocaleLowerCase('zh-CN'))
  }
  return texts
}

/**
 * 搜索命中之外的行 id。搜索是「压暗未命中」而不是「过滤掉未命中」，因此返回的是要压暗
 * 的集合；查询为空时返回 undefined，让调用方跳过整张表而不是构造一个空集合逐行询问。
 */
export function buildModelRequestTrajectorySearchMutes(
  rows: readonly SandboxModelRequestTrajectoryRow[],
  query: string,
  searchTexts: ReadonlyMap<string, string>,
): ReadonlySet<string> | undefined {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return undefined
  const muted = new Set<string>()
  for (const row of rows) {
    if (!searchTexts.get(row.id)?.includes(normalized)) muted.add(row.id)
  }
  return muted
}
