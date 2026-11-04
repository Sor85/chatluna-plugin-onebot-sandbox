import type {
  ClearSandboxModelRequestRecordsResult,
  SandboxModelRequestDetail,
  SandboxModelRequestRecordsPage,
  SandboxModelRequestTrajectory,
} from '../../src/types'
import type {
  ClearModelRequestRecordsQuery,
  ModelRequestRecordQuery,
  ModelRequestRecordsQuery,
  ModelRequestTrajectoryQuery,
} from './query'

/**
 * 模型请求记录的客户端 seam。与工作区端口分开：它的输入里没有场景概念，只有记录分类、
 * 游标与记录标识，而工作区端口的输入里也没有模型请求的概念。
 *
 * 它的适配器不注入当前观察空间：分类由调用方显式给出——未归属分类根本没有空间标识，
 * 切到别的空间也不该被当前观察空间覆盖。
 */
export interface ModelRequestPort {
  getModelRequestRecords(input: ModelRequestRecordsQuery): Promise<SandboxModelRequestRecordsPage>
  getModelRequestRecord(input: ModelRequestRecordQuery): Promise<SandboxModelRequestDetail>
  getModelRequestTrajectory(input: ModelRequestTrajectoryQuery): Promise<SandboxModelRequestTrajectory>
  clearModelRequestRecords(input: ClearModelRequestRecordsQuery): Promise<ClearSandboxModelRequestRecordsResult>
}

export type ModelRequestPortOperation = keyof ModelRequestPort
