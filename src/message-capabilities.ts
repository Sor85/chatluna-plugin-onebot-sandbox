import { isInheritedMessage, type ResolvedConversation } from './conversation-resolution'
import { isRecalledMessage, type SandboxGroup, type SandboxGroupMember, type SandboxMessage } from './types'

/**
 * 消息能力的唯一判据。
 *
 * 「这条消息在这个会话里对这个操作者能做什么」问一次，两边都用它：服务端在写入路径上按它
 * 拒绝，客户端把它的答案渲染成右键菜单。分开判会静默漂移——本模块出现之前服务端与客户端
 * 各推导一遍，三处已经分开了：客户端不给事件消息显示贴表情与创建分支、不给已撤回消息显示
 * 回复，而服务端三条都接受。
 *
 * **判据共享，强制仍在服务端。** 客户端拿到的答案只用来渲染菜单，不构成许可；它永远可以被
 * 绕过，因此服务端照旧自己问一遍再拒绝。
 *
 * 形态与 {@link ./conversation-resolution} 一致：一组接收沙盒实体的纯函数，不持有场景。判据
 * 不做可见性校验——「这个操作者看不看得见这个会话」是另一个问题，由调用方各自的可见性校验
 * 负责，本模块只回答「看得见之后能做什么」。
 */

/** 一条消息在某个逻辑会话里对某个操作者可执行的动作集合。 */
export interface MessageCapabilities {
  /** 撤回。 */
  readonly recall: boolean
  /** 贴表情，含切换一条已有回应。 */
  readonly react: boolean
  /** 引用它回复。 */
  readonly reply: boolean
  /** 以它为分叉点创建分支。 */
  readonly branch: boolean
  /** 进入合并转发多选。 */
  readonly forward: boolean
}

export type MessageCapability = keyof MessageCapabilities

/**
 * 动作做不到的依据。
 *
 * 服务端按它选既有错误文案：文案是外部测试控制器已经在断言的用户可见事实，收成一处判据
 * 不改变任何一句。判据本身只说「不行，因为什么」，具体措辞留给各入口。
 */
export type MessageCapabilityDenial =
  /** 事件消息：真实 QQ 里系统提示不是一条可操作的消息。 */
  | 'event-message'
  /** 已撤回：撤回是生命周期状态，不是把消息变回可操作。 */
  | 'recalled-message'
  /** 继承前缀：它是与来源会话共享的同一份记录，在实例视图里只读。 */
  | 'inherited-prefix'
  /** 还没有当前操作者，因此没有人可以执行写入动作。 */
  | 'no-operator'
  /** 私聊里只能撤回自己发的消息。 */
  | 'not-own-message'
  /** 操作者不在群组中。 */
  | 'actor-not-in-group'
  /** 消息作者已经不在群组中。 */
  | 'author-not-in-group'
  /** 群内撤回别人的消息需要群主或管理员。 */
  | 'requires-group-authority'
  /** 管理员不能撤群主或同级管理员的消息。 */
  | 'target-outranks-actor'

export interface MessageCapabilityInput {
  /** 被判定的消息。 */
  readonly message: SandboxMessage
  /** 这条消息正在哪个逻辑会话里被读到；与消息自身的归属不同时它是继承前缀。 */
  readonly conversation: ResolvedConversation
  /** 当前操作者；缺省表示还没有操作者。 */
  readonly operatorId?: string
  /** 群聊会话所属的群组；私聊为 undefined。 */
  readonly group?: SandboxGroup
}

/** 一条都做不到。没有当前会话时客户端用它，比让每个读取点各自兜底一次更少出错。 */
export const NO_MESSAGE_CAPABILITIES: MessageCapabilities = {
  recall: false,
  react: false,
  reply: false,
  branch: false,
  forward: false,
}

/**
 * 判据本体：动作做不到时给出依据，做得到时返回 undefined。
 *
 * 服务端用它——它需要知道「为什么不行」才能抛出与收敛前一致的文案；客户端只需要布尔位，
 * 走 {@link readMessageCapabilities}。两者同源，位为真等价于这里返回 undefined。
 */
export function denyMessageCapability(
  capability: MessageCapability,
  input: MessageCapabilityInput,
): MessageCapabilityDenial | undefined {
  const { message } = input
  switch (capability) {
    case 'reply':
      // 系统提示不是一条可引用的消息：真实 QQ 里戳一戳这类事件是通知，压根没有消息编号可引用。
      // 引用一条已撤回的消息则等于给原文开一条旁路，撤回因此形同虚设。
      if (message.event) return 'event-message'
      return isRecalledMessage(message) ? 'recalled-message' : undefined
    case 'branch':
      // 分支的起点必须是一句真的说过的话；系统提示没有可分叉的对话上下文。
      return message.event ? 'event-message' : undefined
    case 'forward':
      if (message.event) return 'event-message'
      return isRecalledMessage(message) ? 'recalled-message' : undefined
    case 'react':
      return denyMessageWrite(input) ?? (input.operatorId ? undefined : 'no-operator')
    case 'recall':
      return denyMessageWrite(input) ?? denyRecallAuthority(input)
  }
}

/** 五项能力位。客户端投影按每条消息取一份，菜单只渲染它。 */
export function readMessageCapabilities(input: MessageCapabilityInput): MessageCapabilities {
  return {
    recall: !denyMessageCapability('recall', input),
    react: !denyMessageCapability('react', input),
    reply: !denyMessageCapability('reply', input),
    branch: !denyMessageCapability('branch', input),
    forward: !denyMessageCapability('forward', input),
  }
}

/**
 * 撤回与贴表情共有的前置：改动一条消息自身的状态。
 *
 * 三条都与操作者无关，因此单独一处：事件消息不是可操作的消息，已撤回消息的状态不再接受改写，
 * 继承前缀在实例视图里只读。
 */
function denyMessageWrite({ message, conversation }: MessageCapabilityInput): MessageCapabilityDenial | undefined {
  if (message.event) return 'event-message'
  if (isRecalledMessage(message)) return 'recalled-message'
  return isInheritedMessage(message, conversation.id) ? 'inherited-prefix' : undefined
}

/**
 * 撤回的群角色阶梯，整个仓库唯一一份。
 *
 * 与群成员菜单的 `assertCanManageMember` 是两个问题：那边回答「一个成员能对另一个成员做
 * 什么」，这里回答「一条消息能不能被撤回」，因此不合并。作者已经退群时保持收敛前的行为，
 * 按「参与者不在群组中」拒绝而不是放行。
 */
function denyRecallAuthority({ message, operatorId, group }: MessageCapabilityInput): MessageCapabilityDenial | undefined {
  if (!operatorId) return 'no-operator'
  if (message.authorId === operatorId) return undefined
  if (!group) return 'not-own-message'
  const actor = findGroupMember(group, operatorId)
  if (!actor) return 'actor-not-in-group'
  const target = findGroupMember(group, message.authorId)
  if (!target) return 'author-not-in-group'
  if (actor.role === 'member') return 'requires-group-authority'
  if (target.role === 'owner' || (actor.role === 'admin' && target.role === 'admin')) return 'target-outranks-actor'
  return undefined
}

function findGroupMember(group: SandboxGroup, participantId: string): SandboxGroupMember | undefined {
  return group.members.find((member) => member.participantId === participantId)
}
