import type {
  ClearSandboxModelRequestRecordsResult,
  GetSandboxModelRequestRecordInput,
  GetSandboxModelRequestRecordsInput,
  SandboxModelRequestCapacity,
  SandboxModelRequestDetail,
  SandboxModelRequestListItem,
  SandboxModelRequestRecordsPage,
  SandboxModelRequestScope,
  SandboxModelRequestTrajectory,
} from '../../src/types'

export const MODEL_REQUEST_PAGE_SIZE = 50
export const MAIN_MODEL_REQUEST_SPACE_ID = 'main'

export type ModelRequestRecordsQuery = GetSandboxModelRequestRecordsInput & SandboxModelRequestScope
export type ModelRequestRecordQuery = GetSandboxModelRequestRecordInput & SandboxModelRequestScope
export type ModelRequestTrajectoryQuery = GetSandboxModelRequestRecordInput & SandboxModelRequestScope & {
  mode: 'request' | 'conversation'
  /** 会话账本按请求按需展开：只有这些请求要事件行，其余只取请求边界行。 */
  expandedRequestIds?: readonly string[]
}
export type ClearModelRequestRecordsQuery = SandboxModelRequestScope

export interface ModelRequestRecordsPageState {
  hasMore: boolean
  nextCursor?: number
  nextCreatedAt?: string
  nextId?: string
  earliestCursor?: number
  capacity: SandboxModelRequestCapacity
}

export const emptyModelRequestCapacity: SandboxModelRequestCapacity = {
  recordCount: 0,
  totalBytes: 0,
  maxRecords: 500,
  maxBytes: 50 * 1024 * 1024,
}

export const emptyModelRequestRecordsPage: SandboxModelRequestRecordsPage = {
  records: [],
  hasMore: false,
  capacity: emptyModelRequestCapacity,
}

export function createAllModelRequestScope(): Extract<SandboxModelRequestScope, { scope: 'all' }> {
  return { scope: 'all' }
}

export function createSpaceModelRequestScope(spaceId: string): Extract<SandboxModelRequestScope, { scope: 'space' }> {
  return { scope: 'space', spaceId }
}

export function createUnattributedModelRequestScope(): Extract<SandboxModelRequestScope, { scope: 'unattributed' }> {
  return { scope: 'unattributed' }
}

export function resolveModelRequestScope(
  category: 'all' | 'space' | 'unattributed',
  spaceId = MAIN_MODEL_REQUEST_SPACE_ID,
): SandboxModelRequestScope {
  if (category === 'unattributed') return createUnattributedModelRequestScope()
  if (category === 'all') return createAllModelRequestScope()
  return createSpaceModelRequestScope(spaceId || MAIN_MODEL_REQUEST_SPACE_ID)
}

export function createModelRequestRecordsQuery(
  scope: SandboxModelRequestScope,
  input: GetSandboxModelRequestRecordsInput = {},
): ModelRequestRecordsQuery {
  return { ...scope, ...input, limit: input.limit ?? MODEL_REQUEST_PAGE_SIZE }
}

export type {
  ClearSandboxModelRequestRecordsResult,
  SandboxModelRequestDetail,
  SandboxModelRequestListItem,
  SandboxModelRequestRecordsPage,
  SandboxModelRequestScope,
  SandboxModelRequestTrajectory,
}
