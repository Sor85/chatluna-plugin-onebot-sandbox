import type {
  BranchConversationInstanceInput,
  ClearConversationMessagesInput,
  ClearSandboxOneBotDebugRecordsResult,
  CreateConversationInstanceInput,
  DeleteConversationInstanceInput,
  DeleteGroupAnnouncementInput,
  GetForwardMessageInput,
  GetMediaContentInput,
  GetMessageHistoryInput,
  GetSandboxOneBotDebugRecordInput,
  GetSandboxOneBotDebugRecordsInput,
  GetSandboxWorkspaceInput,
  ManageSandboxEnvironmentInput,
  PerformFriendActionInput,
  PerformGroupActionInput,
  RecallMessageInput,
  RenameConversationInstanceInput,
  SandboxConsoleOneBotDebugRecord,
  SandboxConversationInstanceResult,
  SandboxForward,
  SandboxMediaContent,
  SandboxMessageHistory,
  SandboxMessageSearchResult,
  SandboxOneBotDebugRecordsPage,
  SandboxWorkspaceState,
  SearchConversationMessagesInput,
  SendForwardMessageInput,
  SendMediaMessageInput,
  SendMessageInput,
  SetGroupAnnouncementInput,
  SetMessageReactionInput,
} from './types'
import type { SandboxPresetAssignment } from './chatluna/presets'
import type { ListSandboxTestCallRecordsInput, SandboxTestCallRecordsPage } from './mcp/call-records'
import type { SandboxHttpApiCapabilityCatalog } from './mcp/http-api'
import type {
  SandboxTestCallRecord,
  SandboxMcpCapabilityCatalog,
  SandboxTestCreatedCredential,
  SandboxTestPublicCredential,
  SandboxMcpScope,
} from './mcp/types'
import type { SandboxTestSpaceSummary } from './test-spaces'

/**
 * Console 契约：前后端之间端点名、入参、出参与广播载荷的唯一声明。
 *
 * 服务端的事件映射、对 `@koishijs/console` 的 `Events` 模块增强与客户端 `send` / `receive`
 * 的签名全部从这里派生，加端点只改这一处。本模块只有类型，不 import 控制服务，因此客户端
 * 引用它不会把服务端运行时拖进前端产物；入参与出参一律引用既有领域类型，不复制一份形状。
 *
 * 分组按客户端页面的能力书写，只是给读的人用的；端点集合是全体分组的并集。
 * 鉴权级别不进契约：它是注册时的策略，不是端点的形状。
 */

/** 端点入参统一允许定域到某个 AI 测试空间；省略时作用于主模拟 QQ 环境。 */
export type SpaceScoped<Input> = Input & { spaceId?: string }

/** 会话与消息：单个沙盒场景内部的会话读写、消息收发与媒体读取。 */
export interface SandboxConversationConsoleEvents {
  'onebot-sandbox.workspace': (input?: SpaceScoped<GetSandboxWorkspaceInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.message-history': (input: SpaceScoped<GetMessageHistoryInput>) => Promise<SandboxMessageHistory>
  'onebot-sandbox.search-conversation-messages': (input: SpaceScoped<SearchConversationMessagesInput>) => Promise<SandboxMessageSearchResult>
  'onebot-sandbox.send-message': (input: SpaceScoped<SendMessageInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.create-conversation-instance': (input: SpaceScoped<CreateConversationInstanceInput>) => Promise<SandboxConversationInstanceResult>
  'onebot-sandbox.branch-conversation-instance': (input: SpaceScoped<BranchConversationInstanceInput>) => Promise<SandboxConversationInstanceResult>
  'onebot-sandbox.rename-conversation-instance': (input: SpaceScoped<RenameConversationInstanceInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.delete-conversation-instance': (input: SpaceScoped<DeleteConversationInstanceInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.send-media-message': (input: SpaceScoped<SendMediaMessageInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.send-forward-message': (input: SpaceScoped<SendForwardMessageInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.get-forward-message': (input: SpaceScoped<GetForwardMessageInput>) => Promise<SandboxForward>
  'onebot-sandbox.recall-message': (input: SpaceScoped<RecallMessageInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.clear-conversation-messages': (input: SpaceScoped<ClearConversationMessagesInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.set-message-reaction': (input: SpaceScoped<SetMessageReactionInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.media-content': (input: SpaceScoped<GetMediaContentInput>) => Promise<SandboxMediaContent>
}

/** 环境与关系：参与者目录、群公告与好友群关系的变更。 */
export interface SandboxEnvironmentConsoleEvents {
  'onebot-sandbox.set-group-announcement': (input: SpaceScoped<SetGroupAnnouncementInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.delete-group-announcement': (input: SpaceScoped<DeleteGroupAnnouncementInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.manage-environment': (input: SpaceScoped<ManageSandboxEnvironmentInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.friend-action': (input: SpaceScoped<PerformFriendActionInput>) => Promise<SandboxWorkspaceState>
  'onebot-sandbox.group-action': (input: SpaceScoped<PerformGroupActionInput>) => Promise<SandboxWorkspaceState>
}

/** 调试记录：OneBot 调试记录的联邦读取与清理。 */
export interface SandboxDebugRecordConsoleEvents {
  'onebot-sandbox.debug-records': (input?: SpaceScoped<GetSandboxOneBotDebugRecordsInput>) => Promise<SandboxOneBotDebugRecordsPage<SandboxConsoleOneBotDebugRecord>>
  'onebot-sandbox.debug-record': (input: SpaceScoped<GetSandboxOneBotDebugRecordInput>) => Promise<SandboxConsoleOneBotDebugRecord>
  'onebot-sandbox.clear-debug-records': (input?: { spaceId?: string }) => Promise<ClearSandboxOneBotDebugRecordsResult>
}

/**
 * 测试端点管理：测试调用记录、测试凭证、两种协议表述各自的能力目录与服务器活动。
 *
 * 只有 MCP 表述独有的东西才带 `mcp` 前缀——协议能力目录（工具、资源、`serverCapabilities`）
 * 与服务器活动。测试调用记录与测试凭证由两种表述共用同一份，用 MCP 命名会把「只有 MCP 那
 * 一种表述用得上」写进契约；`http-capabilities` 对称地只描述 HTTP 表述的协议翻译事实。
 */
export interface SandboxTestEndpointConsoleEvents {
  'onebot-sandbox.test-call-records': (input?: ListSandboxTestCallRecordsInput) => SandboxTestCallRecordsPage
  'onebot-sandbox.test-call-record': (input: { recordId: string }) => SandboxTestCallRecord
  'onebot-sandbox.clear-test-call-records': () => { cleared: number }
  'onebot-sandbox.mcp-capabilities': () => SandboxMcpCapabilityCatalog
  'onebot-sandbox.http-capabilities': () => SandboxHttpApiCapabilityCatalog
  'onebot-sandbox.test-credentials': () => SandboxTestPublicCredential[]
  'onebot-sandbox.create-test-credential': (input: { name: string; scopes: SandboxMcpScope[] }) => SandboxTestCreatedCredential
  'onebot-sandbox.update-test-credential': (input: { id: string; name?: string; scopes?: SandboxMcpScope[] }) => SandboxTestPublicCredential
  'onebot-sandbox.rotate-test-credential-token': (input: { id: string }) => SandboxTestCreatedCredential
  'onebot-sandbox.set-test-credential-enabled': (input: { id: string; enabled: boolean }) => void
  'onebot-sandbox.revoke-test-credential': (input: { id: string }) => void
}

/** 测试空间：AI 测试空间自身的存在与归属。 */
export interface SandboxTestSpaceConsoleEvents {
  'onebot-sandbox.test-spaces': () => SandboxTestSpaceSummary[]
  'onebot-sandbox.create-test-space': (input: { name?: string }) => SandboxTestSpaceSummary
  'onebot-sandbox.take-over-test-space': (input: { spaceId: string }) => SandboxTestSpaceSummary
  'onebot-sandbox.return-test-space': (input: { spaceId: string }) => SandboxTestSpaceSummary
  'onebot-sandbox.terminate-test-space': (input: { spaceId: string }) => SandboxTestSpaceSummary
  'onebot-sandbox.reactivate-test-space': (input: { spaceId: string }) => SandboxTestSpaceSummary
  'onebot-sandbox.delete-test-space': (input: { spaceId: string }) => void
}

/** 机器人预设：编辑机器人时可选的 ChatLuna 预设与沙盒写下的切换。 */
export interface SandboxBotPresetCatalog {
  /** ChatLuna 的预设服务是否已加载；没加载时两份列表都为空。 */
  available: boolean
  presets: { id: string; name: string; status: string }[]
  assignments: SandboxPresetAssignment[]
}

export interface SandboxPresetConsoleEvents {
  'onebot-sandbox.bot-presets': () => SandboxBotPresetCatalog
  /** `presetId` 为 null 时撤掉切换，恢复路由原本的预设。 */
  'onebot-sandbox.set-bot-preset': (input: SpaceScoped<{ botId: string; presetId: string | null }>) => Promise<SandboxBotPresetCatalog>
}

/** 端点集合是全体分组的并集；服务端注册与客户端消费都以它为唯一名单。 */
export interface SandboxConsoleEvents extends
  SandboxConversationConsoleEvents,
  SandboxEnvironmentConsoleEvents,
  SandboxPresetConsoleEvents,
  SandboxDebugRecordConsoleEvents,
  SandboxTestEndpointConsoleEvents,
  SandboxTestSpaceConsoleEvents {}

/** 场景变更广播载荷：`spaceId` 省略时表示主模拟 QQ 环境。 */
export interface SandboxSceneMutationPayload {
  spaceId?: string
  revision: number
}

/** MCP 服务器活动广播载荷。 */
export interface SandboxMcpActivityPayload {
  running: boolean
}

/** 广播频道名到载荷；服务端 `broadcast` 从这里取类型，`webui.ts` 把它们折叠进实时信号。 */
export interface SandboxConsoleBroadcasts {
  'onebot-sandbox.scene-mutated': SandboxSceneMutationPayload
  'onebot-sandbox.mcp-activity': SandboxMcpActivityPayload
}
