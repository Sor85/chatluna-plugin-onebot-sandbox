import type {
  ClearSandboxOneBotDebugRecordsResult,
  GetSandboxOneBotDebugRecordInput,
  GetSandboxOneBotDebugRecordsInput,
  SandboxConsoleOneBotDebugRecord,
  SandboxOneBotDebugRecordsPage,
} from '../../src/types'

/**
 * OneBot 调试记录的客户端 seam。与工作区端口分开：它的输入里只有记录标识、筛选与可选的
 * 空间标识，没有任何场景概念；工作区端口的输入里也没有调试记录的概念。
 *
 * 四道记录域端口里只有这一道定域：它的工厂收同一个「解析当前空间标识」的函数，适配器按
 * 当前观察空间补 `spaceId`。定域发生在适配器往请求里注入的那一步，不是 interface 上的概念，
 * 因此不构成与工作区端口「共享概念」。
 */
export interface OneBotDebugPort {
  getOneBotDebugRecords(input?: GetSandboxOneBotDebugRecordsInput): Promise<SandboxOneBotDebugRecordsPage<SandboxConsoleOneBotDebugRecord>>
  getOneBotDebugRecord(input: GetSandboxOneBotDebugRecordInput & { spaceId?: string }): Promise<SandboxConsoleOneBotDebugRecord>
  clearOneBotDebugRecords(): Promise<ClearSandboxOneBotDebugRecordsResult>
}

export type OneBotDebugPortOperation = keyof OneBotDebugPort
