import { listConversationIds } from './conversation-resolution'
import type {
  SandboxConsoleBroadcasts,
  SandboxConsoleEvents,
  SpaceScoped,
} from './console-contract'
import type { SandboxControlService } from './control-service'
import type { SandboxHttpApiCapabilityCatalog } from './mcp/http-api'
import type { SandboxMcpService } from './mcp/service'
import type { SandboxMcpEndpointDescription } from './mcp/types'
import { trimSnapshotMessages, type SandboxTestSpaceService } from './test-spaces'
import type { SandboxOneBotDebugStore } from './onebot-debug'
import { createScopeDirectory, type SceneScope } from './scope-directory'
import type {
  ClearSandboxOneBotDebugRecordsResult,
  DeleteGroupAnnouncementInput,
  GetSandboxOneBotDebugRecordInput,
  GetSandboxOneBotDebugRecordsInput,
  GetSandboxWorkspaceInput,
  ManageSandboxEnvironmentInput,
  PerformFriendActionInput,
  PerformGroupActionInput,
  RecallMessageInput,
  ClearConversationMessagesInput,
  BranchConversationInstanceInput,
  CreateConversationInstanceInput,
  DeleteConversationInstanceInput,
  RenameConversationInstanceInput,
  SearchConversationMessagesInput,
  SetMessageReactionInput,
  SandboxAppearance,
  SandboxConsoleOneBotDebugRecord,
  SandboxEntitySource,
  GetForwardMessageInput,
  GetMediaContentInput,
  GetMessageHistoryInput,
  SandboxOneBotDebugRecordsPage,
  SandboxWorkspaceState,
  SendForwardMessageInput,
  SendMediaMessageInput,
  SendMessageInput,
  SetGroupAnnouncementInput,
} from './types'
import { getSandboxUsers, SandboxDomainError } from './types'

const legacyRpcFields = ['senderId', 'botId', 'actorUserId', 'userId', 'currentUserId'] as const

function hasOwnField(input: unknown, field: string): boolean {
  return input !== null && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, field)
}

function assertNoLegacyRpcFields(input: unknown): void {
  const field = legacyRpcFields.find((candidate) => hasOwnField(input, candidate))
  if (field) throw new Error(`不支持旧 RPC 字段：${field}`)
}

function assertInteractionInput<Input>(input: Input): Input {
  assertNoLegacyRpcFields(input)
  return input
}

function assertEnvironmentInput(input: ManageSandboxEnvironmentInput): ManageSandboxEnvironmentInput {
  if (hasOwnField(input, 'operatorId')) throw new Error('环境管理不接受操作者字段：operatorId')
  assertNoLegacyRpcFields(input)
  return input
}

export interface SandboxConsoleRegistrar {
  addEntry(): unknown
  addListener<Event extends keyof SandboxConsoleEvents>(
    event: Event,
    callback: SandboxConsoleEvents[Event],
    options: { authority: number },
  ): unknown
  broadcast<Channel extends keyof SandboxConsoleBroadcasts>(
    type: Channel,
    body: SandboxConsoleBroadcasts[Channel],
  ): unknown
}

/**
 * 测试控制端点在 Console 侧的两半：测试控制服务与 HTTP 表述的自述。
 *
 * 合成一个可空值而不是两个各自可空的参数：两者都出自插件入口的同一次端点构造，拆开会让
 * 「有测试控制服务却没有 HTTP 表述自述」这个不存在的状态变得可表达，而那正好是
 * `http-capabilities` 端点漏注册、契约守卫报「声明了却没有注册监听器」的形态。
 *
 * 自述以数据形式传入而不是在这里现算：路由与状态码映射归 `src/mcp/http-api.ts` 所有，
 * 监听地址与路径归插件配置所有，本模块两者都不该知道。
 */
export interface SandboxConsoleTestEndpoint {
  mcp: SandboxMcpService
  httpApi: SandboxHttpApiCapabilityCatalog
  mcpEndpoint: SandboxMcpEndpointDescription
}

export function registerConsole(
  console: SandboxConsoleRegistrar,
  control: SandboxControlService,
  appearance: SandboxAppearance,
  endpoint?: SandboxConsoleTestEndpoint,
  testSpaces?: SandboxTestSpaceService,
) {
  console.addEntry()

  // 场景变更实时广播给 WebQQ：发送消息不再等待机器人处理完成，机器人回复靠此通知前端刷新。
  control.onSceneMutation(({ revision }) => {
    void console.broadcast('onebot-sandbox.scene-mutated', { revision })
  })
  testSpaces?.onSpaceCreated((spaceId, spaceControl) => {
    spaceControl.onSceneMutation(({ revision }) => {
      void console.broadcast('onebot-sandbox.scene-mutated', { spaceId, revision })
    })
  })

  const resolveControl = (input: { spaceId?: string } | undefined, mutation: boolean) => {
    if (!input?.spaceId) return control
    if (!testSpaces) throw new Error('AI 测试空间服务不可用')
    return mutation ? testSpaces.requireUserControl(input.spaceId) : testSpaces.getControl(input.spaceId)
  }
  /**
   * 「谁是全部记录域」的唯一答案。可选服务的判空在此被吸收一次，之后不再出现。
   *
   * 由本函数入口包装而不是由插件入口传入：两处消费方（这里与测试控制服务）从同样的输入
   * 派生，内容不可能漂移，而改成入口统一创建要动两个函数的签名与二十多处测试调用点。
   */
  const scopes = createScopeDirectory({ control, testSpaces })
  const resolveReadyControl = async (input: { spaceId?: string } | undefined, mutation: boolean) => {
    const activeControl = resolveControl(input, mutation)
    await activeControl.waitForSceneReady()
    return activeControl
  }
  const withoutSpaceId = <Input extends { spaceId?: string }>(input: Input): Omit<Input, 'spaceId'> => {
    const { spaceId: _spaceId, ...rest } = input
    return rest
  }
  const mainSource: SandboxEntitySource = { type: 'main', name: '主环境' }
  /**
   * 记录域目录只提供标识、名字与是不是主环境；投影成哪种来源形状留在这里。
   *
   * 来源形状属于 Console 契约的出参，让枚举模块去产出它等于把出参声明搬出契约。
   */
  const sceneSource = (scope: SceneScope): SandboxEntitySource => (scope.kind === 'main'
    ? mainSource
    : { type: 'test-space', spaceId: scope.id, name: scope.name })
  const getDebugPage = async (
    store: SandboxOneBotDebugStore,
    source: SandboxEntitySource,
    input: GetSandboxOneBotDebugRecordsInput,
  ): Promise<SandboxOneBotDebugRecordsPage<SandboxConsoleOneBotDebugRecord>> => {
    const page = await store.getRecords(input)
    return {
      ...page,
      records: page.records.map((record) => ({ ...record, source })),
    }
  }
  const listDebugRecords = async (
    input: SpaceScoped<GetSandboxOneBotDebugRecordsInput> = {},
  ): Promise<SandboxOneBotDebugRecordsPage<SandboxConsoleOneBotDebugRecord>> => {
    const query = withoutSpaceId(input)
    if (input.spaceId) {
      if (!testSpaces) throw new Error('AI 测试空间服务不可用')
      const space = testSpaces.getSpace(input.spaceId)
      const spaceControl = testSpaces.getControl(space.id)
      await spaceControl.waitForPersistence()
      return getDebugPage(spaceControl.getOneBotDebugStore(), {
        type: 'test-space',
        spaceId: space.id,
        name: space.name,
      }, query)
    }
    // 联邦视图跨多个独立 sequence，仅聚合首页；精确游标分页必须带 spaceId，因此不声明续页游标。
    return scopes.federate(
      (scope) => getDebugPage(scope.debugRecords, sceneSource(scope), { ...query, beforeSequence: undefined }),
      {
        limit: Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200),
        order: query.order === 'asc' ? 'asc' : 'desc',
        tieBreak: ({ sequence }) => sequence,
      },
    )
  }
  const getDebugRecord = async (input: SpaceScoped<GetSandboxOneBotDebugRecordInput>): Promise<SandboxConsoleOneBotDebugRecord> => {
    const query = withoutSpaceId(input)
    const includeLargeValues = query.includeLargeValues === true
    if (input.spaceId) {
      if (!testSpaces) throw new Error('AI 测试空间服务不可用')
      const space = testSpaces.getSpace(input.spaceId)
      const spaceControl = testSpaces.getControl(space.id)
      await spaceControl.waitForPersistence()
      return {
        ...await spaceControl.getOneBotDebugStore().requireRecord(query.recordId, includeLargeValues),
        source: { type: 'test-space', spaceId: space.id, name: space.name },
      }
    }
    const hit = await scopes.findFirst((scope) => scope.debugRecords.getRecord(query.recordId, includeLargeValues))
    if (!hit) throw new SandboxDomainError(`调试记录不存在：${query.recordId}`)
    return { ...hit.value, source: sceneSource(hit.scope) }
  }
  const clearDebugRecords = async (input: { spaceId?: string } = {}): Promise<ClearSandboxOneBotDebugRecordsResult> => {
    if (input.spaceId) return { cleared: await resolveControl(input, true).getOneBotDebugStore().clear() }
    // 主调试页展示的是联邦视图，清理必须覆盖运行中的 AI 空间，不能要求用户先接管。
    const cleared = await scopes.forEachScene(({ debugRecords }) => debugRecords.clear())
    return { cleared: cleared.reduce((total, count) => total + count, 0) }
  }
  const getWorkspace = async (input: SpaceScoped<GetSandboxWorkspaceInput> = {}): Promise<SandboxWorkspaceState> => {
    assertNoLegacyRpcFields(input)
    const activeControl = await resolveReadyControl(input, false)
    const snapshot = activeControl.getSnapshot()
    if (input.operatorId && !snapshot.participants.some(({ id }) => id === input.operatorId)) {
      throw new Error(`参与者不存在：${input.operatorId}`)
    }
    const visibleParticipantId = input.operatorId ?? getSandboxUsers(snapshot)[0]?.id ?? snapshot.participants[0]?.id
    const visibleSnapshot = visibleParticipantId ? activeControl.getVisibleSnapshot(visibleParticipantId, input.messageLimit) : snapshot
    const visibleConversationIds = listConversationIds(visibleSnapshot)
    return {
      snapshot: visibleSnapshot,
      chatLunaStates: activeControl.getChatLunaStates().filter(({ conversationId }) => visibleConversationIds.has(conversationId)),
      appearance,
      persistence: control.getPersistenceStatus(),
    }
  }

  // Koishi 的 Events 映射规模较大，直接调用泛型 addListener 会让 TypeScript
  // 展开整个事件联合并触发 TS2590；这里保留事件名约束，回调由各领域函数自身类型校验。
  const registerListener = console.addListener.bind(console) as (
    event: keyof SandboxConsoleEvents,
    callback: (...args: any[]) => any,
    options: { authority: number },
  ) => unknown
  const workspaceListener = (input?: SpaceScoped<GetSandboxWorkspaceInput>) => getWorkspace(input)
  registerListener('onebot-sandbox.workspace', workspaceListener, { authority: 4 })
  registerListener('onebot-sandbox.message-history', async (input) => (await resolveReadyControl(input, false)).getMessageHistory(assertInteractionInput(withoutSpaceId(input)) as GetMessageHistoryInput), { authority: 4 })
  registerListener('onebot-sandbox.search-conversation-messages', async (input) => (
    await resolveReadyControl(input, false)
  ).searchConversationMessages(assertInteractionInput(withoutSpaceId(input)) as SearchConversationMessagesInput), { authority: 4 })
  registerListener('onebot-sandbox.create-conversation-instance', async (input) => {
    // 与其余变更端点同口径返回完整工作区状态，外加新会话 ID，客户端一次请求完成状态替换与选中。
    const { conversationId } = (await resolveReadyControl(input, true))
      .createConversationInstance(assertInteractionInput(withoutSpaceId(input)) as CreateConversationInstanceInput)
    return { ...await getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId }), conversationId }
  }, { authority: 4 })
  registerListener('onebot-sandbox.branch-conversation-instance', async (input) => {
    const { conversationId } = (await resolveReadyControl(input, true))
      .branchConversationInstance(assertInteractionInput(withoutSpaceId(input)) as BranchConversationInstanceInput)
    return { ...await getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId }), conversationId }
  }, { authority: 4 })
  registerListener('onebot-sandbox.rename-conversation-instance', async (input) => {
    (await resolveReadyControl(input, true))
      .renameConversationInstance(assertInteractionInput(withoutSpaceId(input)) as RenameConversationInstanceInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.delete-conversation-instance', async (input) => {
    (await resolveReadyControl(input, true))
      .deleteConversationInstance(assertInteractionInput(withoutSpaceId(input)) as DeleteConversationInstanceInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.send-message', async (input) => {
    // 消息同步落库后立即返回，机器人投递在后台继续：让 WebQQ 的用户消息不被插件处理时长阻塞。
    // 吞掉这个 Promise 是安全的——投递模块对派发前后的任何失败都会写调试记录并记一行日志。
    const { delivery } = (await resolveReadyControl(input, true)).startMessageSend(assertInteractionInput(withoutSpaceId(input)) as SendMessageInput)
    delivery.catch(() => {})
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.send-media-message', async (input) => {
    // 与发送文字同一套后台投递语义，失败同样由投递模块留痕。
    const { delivery } = (await resolveReadyControl(input, true)).startMediaMessageSend(assertInteractionInput(withoutSpaceId(input)) as SendMediaMessageInput)
    delivery.catch(() => {})
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.send-forward-message', async (input) => {
    // 合并转发领域路径会等待机器人投递，保证返回的工作区已包含外层 forward 卡片。
    await (await resolveReadyControl(input, true)).sendForwardMessage(assertInteractionInput(withoutSpaceId(input)) as SendForwardMessageInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.get-forward-message', async (input) => (
    await resolveReadyControl(input, false)
  ).getForwardMessage(assertInteractionInput(withoutSpaceId(input)) as GetForwardMessageInput), { authority: 4 })
  registerListener('onebot-sandbox.recall-message', async (input) => {
    await (await resolveReadyControl(input, true)).recallMessage(assertInteractionInput(withoutSpaceId(input)) as RecallMessageInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.clear-conversation-messages', async (input) => {
    (await resolveReadyControl(input, true)).clearConversationMessages(assertInteractionInput(withoutSpaceId(input)) as ClearConversationMessagesInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.set-message-reaction', async (input) => {
    await (await resolveReadyControl(input, true)).setMessageReaction(assertInteractionInput(withoutSpaceId(input)) as SetMessageReactionInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.media-content', async (input) => (await resolveReadyControl(input, false)).getMediaContent(assertInteractionInput(withoutSpaceId(input)) as GetMediaContentInput), { authority: 4 })
  registerListener('onebot-sandbox.set-group-announcement', async (input) => {
    (await resolveReadyControl(input, true)).setGroupAnnouncement(assertInteractionInput(withoutSpaceId(input)) as SetGroupAnnouncementInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.delete-group-announcement', async (input) => {
    (await resolveReadyControl(input, true)).deleteGroupAnnouncement(assertInteractionInput(withoutSpaceId(input)) as DeleteGroupAnnouncementInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.manage-environment', async (input) => {
    const activeControl = await resolveReadyControl(input, true)
    const command = assertEnvironmentInput(withoutSpaceId(input) as ManageSandboxEnvironmentInput)
    switch (command.action) {
      case 'create-user':
        activeControl.createUser({ ...command.data, avatar: await activeControl.importAvatar('user', command.data.id, command.data.avatar) })
        break
      case 'update-user':
        activeControl.updateUser(command.data.avatar === undefined ? command.data : { ...command.data, avatar: await activeControl.importAvatar('user', command.data.id, command.data.avatar) })
        break
      case 'delete-user':
        activeControl.deleteUser(command.data)
        break
      case 'create-bot':
        activeControl.createBot({ ...command.data, avatar: await activeControl.importAvatar('bot', command.data.id, command.data.avatar) })
        break
      case 'update-bot':
        activeControl.updateBot(command.data.avatar === undefined ? command.data : { ...command.data, avatar: await activeControl.importAvatar('bot', command.data.id, command.data.avatar) })
        break
      case 'delete-bot':
        activeControl.deleteBot(command.data)
        break
      case 'create-group':
        activeControl.createGroup({ ...command.data, avatar: await activeControl.importAvatar('group', command.data.id, command.data.avatar) })
        break
      case 'update-group':
        activeControl.updateGroup(command.data.avatar === undefined ? command.data : { ...command.data, avatar: await activeControl.importAvatar('group', command.data.id, command.data.avatar) })
        break
      case 'delete-group':
        activeControl.deleteGroup(command.data)
        break
    }
    return getWorkspace({ spaceId: input.spaceId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.friend-action', async (input) => {
    await (await resolveReadyControl(input, true)).performFriendAction(assertInteractionInput(withoutSpaceId(input)) as PerformFriendActionInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.group-action', async (input) => {
    await (await resolveReadyControl(input, true)).performGroupAction(assertInteractionInput(withoutSpaceId(input)) as PerformGroupActionInput)
    return getWorkspace({ spaceId: input.spaceId, operatorId: input.operatorId })
  }, { authority: 4 })
  registerListener('onebot-sandbox.debug-records', listDebugRecords, { authority: 4 })
  registerListener('onebot-sandbox.debug-record', getDebugRecord, { authority: 4 })
  registerListener('onebot-sandbox.clear-debug-records', clearDebugRecords, { authority: 4 })
  if (endpoint) {
    const { mcp, httpApi, mcpEndpoint } = endpoint
    mcp.onActivity((running) => {
      void console.broadcast('onebot-sandbox.mcp-activity', { running })
    })
    registerListener('onebot-sandbox.mcp-activity', () => ({ running: mcp.isActivityRunning() }), { authority: 4 })
    registerListener('onebot-sandbox.mcp-capabilities', () => ({ ...mcp.getCapabilityCatalog(), endpoint: mcpEndpoint }), { authority: 4 })
    registerListener('onebot-sandbox.http-capabilities', () => httpApi, { authority: 4 })
    registerListener('onebot-sandbox.test-call-records', (input = {}) => mcp.listCallRecords(input), { authority: 4 })
    registerListener('onebot-sandbox.test-call-record', (input) => mcp.getCallRecord(input.recordId), { authority: 4 })
    registerListener('onebot-sandbox.clear-test-call-records', () => mcp.clearCallRecords(), { authority: 4 })
    registerListener('onebot-sandbox.test-credentials', () => mcp.listCredentials(), { authority: 4 })
    registerListener('onebot-sandbox.create-test-credential', (input) => mcp.createCredential(input.name, input.scopes), { authority: 4 })
    registerListener('onebot-sandbox.update-test-credential', (input) => mcp.updateCredential(input.id, input), { authority: 4 })
    registerListener('onebot-sandbox.rotate-test-credential-token', (input) => mcp.rotateCredentialToken(input.id), { authority: 4 })
    registerListener('onebot-sandbox.set-test-credential-enabled', (input) => mcp.setCredentialEnabled(input.id, input.enabled), { authority: 4 })
    registerListener('onebot-sandbox.revoke-test-credential', (input) => mcp.revokeCredential(input.id), { authority: 4 })
  }
  if (testSpaces) {
    registerListener('onebot-sandbox.test-spaces', () => testSpaces.listSpaces()
      .map((space) => ({ ...space, snapshot: trimSnapshotMessages(space.snapshot, 10) })), { authority: 4 })
    registerListener('onebot-sandbox.create-test-space', ({ name }) => {
      const space = testSpaces.createSpace({ name })
      return testSpaces.takeOver(space.id)
    }, { authority: 4 })
    registerListener('onebot-sandbox.take-over-test-space', ({ spaceId }) => testSpaces.takeOver(spaceId), { authority: 4 })
    registerListener('onebot-sandbox.return-test-space', ({ spaceId }) => testSpaces.returnControl(spaceId), { authority: 4 })
    registerListener('onebot-sandbox.terminate-test-space', ({ spaceId }) => testSpaces.terminateSpace(spaceId), { authority: 4 })
    registerListener('onebot-sandbox.reactivate-test-space', ({ spaceId }) => testSpaces.reactivateSpace(spaceId), { authority: 4 })
    registerListener('onebot-sandbox.delete-test-space', ({ spaceId }) => testSpaces.deleteSpace(spaceId), { authority: 4 })
  }
}
