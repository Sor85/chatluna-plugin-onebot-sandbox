import type { SandboxTestSpaceSummary } from '../../src/test-spaces'

/**
 * AI 测试空间生命周期的客户端 seam。与工作区端口分开：工作区端口读写单个空间内部的
 * 场景状态，本端口只管空间自身的存在与归属，两者的输入里都没有对方的概念。
 */
export interface TestSpacePort {
  listTestSpaces(): Promise<SandboxTestSpaceSummary[]>
  createTestSpace(input?: { name?: string }): Promise<SandboxTestSpaceSummary>
  takeOverTestSpace(input: { spaceId: string }): Promise<SandboxTestSpaceSummary>
  returnTestSpace(input: { spaceId: string }): Promise<SandboxTestSpaceSummary>
  terminateTestSpace(input: { spaceId: string }): Promise<SandboxTestSpaceSummary>
  reactivateTestSpace(input: { spaceId: string }): Promise<SandboxTestSpaceSummary>
  deleteTestSpace(input: { spaceId: string }): Promise<void>
}

export type TestSpacePortOperation = keyof TestSpacePort
