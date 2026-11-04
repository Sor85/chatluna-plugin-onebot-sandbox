import type { SandboxSceneMutationPayload } from '../../src/console-contract'
import type {
  DeleteGroupAnnouncementInput,
  GetForwardMessageInput,
  GetMediaContentInput,
  GetMessageHistoryInput,
  BranchConversationInstanceInput,
  CreateConversationInstanceInput,
  DeleteConversationInstanceInput,
  RenameConversationInstanceInput,
  SandboxConversationInstanceResult,
  GetSandboxWorkspaceInput,
  ManageSandboxEnvironmentInput,
  PerformFriendActionInput,
  PerformGroupActionInput,
  RecallMessageInput,
  ClearConversationMessagesInput,
  SearchConversationMessagesInput,
  SetMessageReactionInput,
  SandboxForward,
  SandboxMediaContent,
  SandboxMessageHistory,
  SandboxMessageSearchResult,
  SandboxWorkspaceState,
  SendForwardMessageInput,
  SendMediaMessageInput,
  SendMessageInput,
  SetGroupAnnouncementInput,
} from '../../src/types'

export type SceneMutationListener = (payload: SandboxSceneMutationPayload) => void

export interface WorkspacePort {
  getWorkspace(input?: GetSandboxWorkspaceInput): Promise<SandboxWorkspaceState>
  getMessageHistory(input: GetMessageHistoryInput): Promise<SandboxMessageHistory>
  createConversationInstance(input: CreateConversationInstanceInput): Promise<SandboxConversationInstanceResult>
  branchConversationInstance(input: BranchConversationInstanceInput): Promise<SandboxConversationInstanceResult>
  renameConversationInstance(input: RenameConversationInstanceInput): Promise<SandboxWorkspaceState>
  deleteConversationInstance(input: DeleteConversationInstanceInput): Promise<SandboxWorkspaceState>
  searchConversationMessages(input: SearchConversationMessagesInput): Promise<SandboxMessageSearchResult>
  sendMessage(input: SendMessageInput): Promise<SandboxWorkspaceState>
  sendMediaMessage(input: SendMediaMessageInput): Promise<SandboxWorkspaceState>
  sendForwardMessage(input: SendForwardMessageInput): Promise<SandboxWorkspaceState>
  getForwardMessage(input: GetForwardMessageInput): Promise<SandboxForward>
  recallMessage(input: RecallMessageInput): Promise<SandboxWorkspaceState>
  clearConversationMessages(input: ClearConversationMessagesInput): Promise<SandboxWorkspaceState>
  setMessageReaction(input: SetMessageReactionInput): Promise<SandboxWorkspaceState>
  /**
   * 显式给出 spaceId 时读该空间的媒体，省略时读端口当前定域的工作区。
   * 空间缩略图要绘制任意测试空间，因此必须能越过隐式定域。
   */
  getMediaContent(input: GetMediaContentInput & { spaceId?: string }): Promise<SandboxMediaContent>
  setGroupAnnouncement(input: SetGroupAnnouncementInput): Promise<SandboxWorkspaceState>
  deleteGroupAnnouncement(input: DeleteGroupAnnouncementInput): Promise<SandboxWorkspaceState>
  manageEnvironment(input: ManageSandboxEnvironmentInput): Promise<SandboxWorkspaceState>
  performFriendAction(input: PerformFriendActionInput): Promise<SandboxWorkspaceState>
  performGroupAction(input: PerformGroupActionInput): Promise<SandboxWorkspaceState>
  /**
   * 订阅服务端的场景变更广播，返回退订函数。适配器负责把一份底层广播扇出给全部订阅者，
   * 因此一个页面退订不会让仍存活的页面失聪。
   *
   * 这个方法不跟随端口的隐式定域：载荷自带 spaceId，哪份沙盒场景变了由广播说了算，
   * 订阅方按自己当前观察的空间过滤。
   */
  subscribeSceneMutation(listener: SceneMutationListener): () => void
}
