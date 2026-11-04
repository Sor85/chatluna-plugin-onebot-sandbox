import { readConversationMessageIds, type ResolvedConversation } from '../../src/conversation-resolution'
import {
  formatRecalledMessageEventText,
  getSandboxBots,
  getSandboxUsers,
  isRecalledMessage,
  type SandboxGroupMember,
  type SandboxSnapshot,
} from '../../src/types'
import { formatMentionContent } from './mention'
import { getConversationPeerId } from './relationship-directory'

/**
 * 侧栏会话树的投影口径：一个根会话在侧栏里长什么样，它的会话实例挂在哪。
 *
 * 形态是纯函数而不是持有场景的对象，与 `environment-directory-model.ts`、
 * `relationship-directory.ts` 一致：把沙盒场景投影成某个视图要的形状，头像解析由调用方注入，
 * 因此不必先起一个完整工作台就能问「这一行长什么样」。
 *
 * 转发目标的「最近」一列由 {@link toRecentForwardTargets} 从同一份结果派生：预览口径变了，
 * 那一列跟着变，两处不会各自漂移。
 */

/** 侧栏会话树里的一行。根会话行与会话实例子项共用这些字段；子项列表不在其中。 */
export interface ConversationTreeRow {
  id: string
  groupId?: string
  /** 根会话还是会话实例；会话实例作为所属根会话的子项展开。 */
  kind: 'root' | 'instance'
  title: string
  avatar?: string
  avatarKind: 'user' | 'bot' | 'group'
  preview: string
  time: string
  actorRole?: SandboxGroupMember['role']
  entityTarget: { type: 'user' | 'bot' | 'group', id: string }
  entityLabel: '用户' | '机器人' | '群组'
}

/** 会话实例子项。它自己不带子项列表：层级严格两层，实例下不再有实例。 */
export interface ConversationTreeInstanceRow extends ConversationTreeRow {
  kind: 'instance'
}

/**
 * 会话树的顶层：根会话行，子项列表一定存在，没有会话实例时为空数组。
 *
 * 子项类型钉成会话实例行而不是任意一行，因此「层级严格两层，实例下不再有实例」
 * （CONTEXT.md「会话实例」、ADR-0076）写在类型上，而不是只写在注释里。
 */
export interface ConversationTreeNode extends ConversationTreeRow {
  kind: 'root'
  children: ConversationTreeInstanceRow[]
}

/**
 * 转发目标的「最近」一列。字段逐项取自会话树的行，复用关系因此写在类型上：
 * 改会话树的标题、预览或头像口径时，这一列会跟着变而不是悄悄留在旧口径上。
 */
export type ConversationTreeForwardTarget = Pick<ConversationTreeRow, 'title' | 'avatar' | 'avatarKind'> & {
  conversationId: ConversationTreeRow['id']
  subtitle: ConversationTreeRow['preview']
}

export interface ConversationTreeInput {
  scene: SandboxSnapshot
  /** 当前操作者可见的会话，根会话与会话实例都在里面。 */
  conversations: readonly ResolvedConversation[]
  operatorId?: string
  resolveAvatar?: (avatar?: string) => string | undefined
}

function identity(avatar?: string) {
  return avatar
}

const EMPTY_PREVIEW = '开始一段新对话'
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

/**
 * 侧栏会话树：顶层只有根会话，每个根会话下挂它自己的会话实例。
 * 数据源是「根会话加其实例列表」，不是「一个扁平集合加父字段」。
 */
export function buildConversationTree(input: ConversationTreeInput): ConversationTreeNode[] {
  const instancesByRoot = new Map<string, ConversationTreeInstanceRow[]>()
  for (const conversation of input.conversations) {
    if (conversation.kind !== 'instance') continue
    const siblings = instancesByRoot.get(conversation.rootConversationId) ?? []
    siblings.push({ ...toRow(input, conversation), kind: 'instance' })
    instancesByRoot.set(conversation.rootConversationId, siblings)
  }
  return input.conversations
    .filter(({ kind }) => kind === 'root')
    .map((conversation) => ({
      ...toRow(input, conversation),
      kind: 'root' as const,
      children: instancesByRoot.get(conversation.id) ?? [],
    }))
}

/** 「最近」一列只收根会话行：会话实例不是转发目标，转发落在联系人这一层。 */
export function toRecentForwardTargets(
  tree: readonly ConversationTreeNode[],
): ConversationTreeForwardTarget[] {
  return tree.map(({ id, title, preview, avatar, avatarKind }) => ({
    conversationId: id,
    title,
    subtitle: preview,
    avatar,
    avatarKind,
  }))
}

function toRow(input: ConversationTreeInput, conversation: ResolvedConversation): ConversationTreeRow {
  const { scene, operatorId } = input
  const resolveAvatar = input.resolveAvatar ?? identity
  const group = conversation.type === 'group'
    ? scene.groups.find(({ id }) => id === conversation.groupId)
    : undefined
  const peerId = getConversationPeerId(conversation, operatorId)
  const bot = getSandboxBots(scene).find(({ id }) => id === peerId)
  const peer = bot ?? getSandboxUsers(scene).find(({ id }) => id === peerId)
  const latestMessage = readLatestMessage(scene, conversation.id)
  return {
    id: conversation.id,
    groupId: group?.id,
    kind: conversation.kind,
    // 会话实例有自己的名字；根会话的名字由参与者关系决定。
    title: conversation.title ?? group?.name ?? peer?.name ?? conversation.id,
    avatar: resolveAvatar(group?.avatar ?? peer?.avatar),
    avatarKind: group ? 'group' : bot ? 'bot' : 'user',
    preview: latestMessage ? describeMessage(scene, latestMessage) : EMPTY_PREVIEW,
    time: latestMessage?.createdAt ? timeFormat.format(new Date(latestMessage.createdAt)) : '',
    actorRole: group?.members.find(({ participantId }) => participantId === operatorId)?.role,
    entityTarget: group
      ? { type: 'group', id: group.id }
      : { type: bot ? 'bot' : 'user', id: peerId ?? '' },
    entityLabel: group ? '群组' : bot ? '机器人' : '用户',
  }
}

/**
 * 预览取拼接后的最后一条：会话实例的消息列表已经把继承前缀物化在自有消息之前，
 * 因此刚分叉出来的会话实例显示分叉点那条，而不是「开始一段新对话」——它不是空会话。
 */
function readLatestMessage(scene: SandboxSnapshot, conversationId: string) {
  const messageIds = new Set(readConversationMessageIds(scene, conversationId))
  return scene.messages.filter(({ id }) => messageIds.has(id)).at(-1)
}

function describeMessage(scene: SandboxSnapshot, message: SandboxSnapshot['messages'][number]) {
  const participantNames = Object.fromEntries(scene.participants.map(({ id, name }) => [id, name]))
  if (!isRecalledMessage(message)) return formatMentionContent(message.content, participantNames)
  const operatorId = message.lifecycle.operatorId
  return formatRecalledMessageEventText(message, participantNames[operatorId] ?? operatorId)
}
