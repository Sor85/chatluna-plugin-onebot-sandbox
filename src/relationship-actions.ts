import type { SandboxFriendship, SandboxGroup, SandboxGroupMember } from './types'

/**
 * 关系操作的领域规则，整个仓库唯一一份。
 *
 * 「谁能对谁做什么、做完之后场景变成什么样、派发哪一条群通知」问一次，两条操作通道都用它：
 * 用户通道直接调它，虚拟 OneBot 机器人经自身 OneBot action 落到同一份规则上。分开写会静默
 * 漂移——本模块出现之前退群、改群名、设管理员、踢人、改群名片这五个动作在控制服务里是两份
 * 逐字重复，差异只有返回值形状与通知里操作者标识的取值来源；修一处群权限要改两处，漏掉一处
 * 的表现是「从 WebQQ 操作正常、机器人操作却不对」，两条路都通，只是规则不一样。
 *
 * **拒绝以可辨识原因表达，文案归通道。** 规则不写中文，只回答「不行，因为什么」；两条通道各自
 * 把同一个原因渲染成自己的文案。形状与 {@link ./message-capabilities} 一致：那份判据返回一个
 * 拒绝原因联合，控制服务里三个渲染函数把同一个原因渲染成撤回、贴表情、回复三套不同措辞。收益
 * 是入群申请审批那两句已有断言的文案（用户「只有群主或管理员可以处理入群申请」、机器人「机器人
 * 没有审批入群申请的权限」）逐字保留，而角色判定只剩一份。
 *
 * 协作者按最小结构化 interface 注入，**不注入宿主类型**，与入站投递模块同口径。本模块
 * **不持有第二份沙盒场景**（ADR-0002 的服务端状态所有权不变）：它只接收群对象与群成员的引用，
 * 就地改写它们，再把「提交这次变更」「派发这条通知」「摘掉这个成员或这条申请」交回控制服务。
 *
 * 通道差异表达在 adapter 里，不表达绕道：机器人仍然只能经自身 OneBot action 执行这些操作，
 * 受启用状态、实现配置与能力覆盖约束（ADR-0076）。因此本模块只有规则，没有「操作者是不是
 * 机器人」这一维。
 */

/** 与真实 QQ 群禁言上限一致，避免插件写入不可能的到期时间。 */
const MAX_GROUP_MUTE_SECONDS = 30 * 24 * 60 * 60

/** 专属头衔的长度上限。 */
const MAX_GROUP_TITLE_LENGTH = 64

/**
 * 关系操作做不到的依据。
 *
 * 通道按它选既有错误文案：文案是 WebQQ 与被测插件已经在断言的用户可见事实，收成一处规则不改变
 * 任何一句。原因本身只说「不行，因为什么」，具体措辞与动作名留给各通道的渲染函数。
 */
export type RelationshipActionDenial =
  /** 群主不能直接退群：场景不允许进入没有群主的状态。 */
  | 'owner-cannot-leave'
  /** 这件事要群主或管理员，本人只是普通成员。 */
  | 'requires-group-authority'
  /** 这件事只有群主能做。 */
  | 'requires-group-owner'
  /** 管理员管不到群主或同级管理员。 */
  | 'target-outranks-actor'
  /** 目标是群主：群主权限不能被改写。 */
  | 'target-is-owner'
  /** 目标就是本人：这件事不能对自己做。 */
  | 'target-is-actor'
  /** 群主身份不能转让给自己。 */
  | 'owner-transfer-to-self'
  /** 群名称去掉首尾空白后为空。 */
  | 'group-name-empty'
  /** 专属头衔超过长度上限。 */
  | 'title-too-long'
  /** 禁言时长为负数或不是有限数。 */
  | 'mute-duration-negative'
  /** 禁言时长超过真实 QQ 的上限。 */
  | 'mute-duration-too-long'

/** 群通知的载荷；踢人要按接收机器人区分子类型，因此也允许按机器人标识求值。 */
export type RelationshipGroupNoticeData =
  | Record<string, unknown>
  | ((botId: string) => Record<string, unknown>)

/**
 * 规则做不到、必须交回控制服务的那几件事。
 *
 * 三类：提交一次场景变更（含把成员从群里摘掉这种连带清理）、派发一条群通知、以及申请与好友
 * 关系集合的写入。它们都要读写沙盒场景本体，而场景归控制服务所有。
 */
export interface RelationshipActionCollaborators {
  /** 提交一次场景变更：推进 revision、收敛保留窗口、落盘并广播。 */
  commitSceneMutation(): void
  /** 向群内的虚拟 OneBot 机器人派发一条群通知。 */
  dispatchGroupNotice(group: SandboxGroup, noticeType: string, data: RelationshipGroupNoticeData): Promise<void>
  /** 把一个参与者从群里摘掉：连带清理它在本群的遗留申请、同步群会话可见性并提交场景变更。 */
  removeGroupMember(group: SandboxGroup, participantId: string): void
  /** 摘掉一条待处理的关系申请。 */
  removeRelationshipRequest(requestId: string): void
  /** 建立好友关系并确保私聊根会话存在；已经是好友时返回既有那一条。 */
  addFriendship(firstId: string, secondId: string): SandboxFriendship
  /** 批准入群后加入新成员、同步群会话并派发入群通知。 */
  addApprovedGroupMember(input: {
    group: SandboxGroup
    participantId: string
    operatorId: string
    subType: 'add' | 'invite'
  }): Promise<void>
}

/** 一次群操作的领域位置：群对象与执行它的那个成员，两者都是场景里的引用。 */
export interface GroupActorInput {
  readonly group: SandboxGroup
  readonly actor: SandboxGroupMember
}

/** 作用在另一个成员身上的群操作。改自己的群名片时 target 就是 actor 自己。 */
export interface GroupTargetInput extends GroupActorInput {
  readonly target: SandboxGroupMember
}

/**
 * 只在两个成员之间生效、不派发群通知的操作。
 *
 * 入参里没有群对象，因为规则确实读不到它：专属头衔与禁言都只改群成员自己的字段，真实 OneBot
 * 实现也不为它们产生 notice，插件从群成员资料和禁言列表复查执行结果。
 */
export interface GroupMemberPairInput {
  readonly actor: SandboxGroupMember
  readonly target: SandboxGroupMember
}

export interface SettleFriendRequestInput {
  readonly requestId: string
  readonly requesterId: string
  /** 申请的接收方，也就是批准后与申请人建立好友关系的那一侧。 */
  readonly targetId: string
  readonly approve: boolean
  /**
   * 批准后、提交场景变更之前对新建立的好友关系做一次补充。
   *
   * 机器人通道用它写备注——`set_friend_add_request` 带 `remark`，用户通道没有这个参数，给用户
   * 通道加它是新功能而不是重构。做成回调而不是入参，备注因此仍然写在机器人 adapter 里，并且
   * 仍然进同一次提交：放到尾巴之后写会让场景变更监听器先收到一份没有备注的快照。
   */
  readonly onApproved?: (friendship: SandboxFriendship) => void
}

export interface SettleGroupRequestInput {
  readonly group: SandboxGroup
  readonly requestId: string
  /** 批准后加入群的参与者。 */
  readonly participantId: string
  /** 入群通知里的操作者标识。 */
  readonly operatorId: string
  readonly subType: 'add' | 'invite'
  readonly approve: boolean
}

/**
 * 八个群动作加两类申请审批的尾巴。
 *
 * 每个动作返回拒绝原因，做得到时返回 undefined——通道据此渲染文案并抛出，或者把自己的返回值
 * 形状（用户通道的 revision、机器人通道的 OneBot 回执）交回调用方。不派发群通知的两个动作
 * （专属头衔、禁言）是同步的，其余都要等通知派发完。
 */
export interface RelationshipActions {
  /** 退群。群主不能直接退，否则场景会失去唯一的群主。 */
  leaveGroup(input: GroupActorInput): Promise<RelationshipActionDenial | undefined>
  /** 改群名称。 */
  renameGroup(input: GroupActorInput & { name: string }): Promise<RelationshipActionDenial | undefined>
  /** 踢出成员。被踢的机器人收到的子类型与旁观者不同。 */
  kickGroupMember(input: GroupTargetInput): Promise<RelationshipActionDenial | undefined>
  /** 设置或取消管理员。 */
  setGroupAdmin(input: GroupTargetInput & { enabled: boolean }): Promise<RelationshipActionDenial | undefined>
  /** 改群名片。改自己的不需要管理权限。 */
  setGroupCard(input: GroupTargetInput & { card: string }): Promise<RelationshipActionDenial | undefined>
  /** 转让群主身份。 */
  transferGroupOwner(input: GroupTargetInput): Promise<RelationshipActionDenial | undefined>
  /** 设置或清除专属头衔。 */
  setGroupMemberTitle(input: GroupMemberPairInput & { title: string }): RelationshipActionDenial | undefined
  /** 禁言或解除禁言。 */
  muteGroupMember(input: GroupMemberPairInput & { durationSeconds: number }): RelationshipActionDenial | undefined
  /**
   * 好友申请审批的共用尾巴：摘掉申请、批准则建立好友关系、最后提交一次场景变更。
   *
   * 前置判定不在这里——谁有权处理、能不能代机器人处理、按什么条件查找申请，两条通道本该不同。
   */
  settleFriendRequest(input: SettleFriendRequestInput): void
  /**
   * 群申请审批的共用尾巴：摘掉申请、批准则加入新成员并派发入群通知、否则只提交场景变更。
   *
   * 与好友那条同理，前置判定留在各自通道。
   */
  settleGroupRequest(input: SettleGroupRequestInput): Promise<void>
}

/**
 * 群主或管理员才能做的事，本人只是普通成员时拒绝。
 *
 * 导出是因为入群申请的审批权限判定也是它，而那道判定发生在通道摘出申请之后、进入共用尾巴
 * 之前，不属于任何一个群动作。两条通道因此都调这一个谓词，再各自渲染自己那句文案。
 */
export function denyGroupAuthority(actor: SandboxGroupMember): RelationshipActionDenial | undefined {
  return actor.role === 'member' ? 'requires-group-authority' : undefined
}

/** 只有群主能做的事。 */
function denyGroupOwnership(actor: SandboxGroupMember): RelationshipActionDenial | undefined {
  return actor.role === 'owner' ? undefined : 'requires-group-owner'
}

/**
 * 一个成员能不能管另一个成员：踢人、改别人的群名片、禁言共用这道阶梯。
 *
 * 与消息能力判据里的撤回阶梯是两个问题（ADR-0078）：那边回答「一条消息能不能被撤回」，这里
 * 回答「一个成员能对另一个成员做什么」，因此不合并。
 */
function denyGroupMemberManagement(
  actor: SandboxGroupMember,
  target: SandboxGroupMember,
): RelationshipActionDenial | undefined {
  const authority = denyGroupAuthority(actor)
  if (authority) return authority
  if (target.role === 'owner' || (actor.role === 'admin' && target.role === 'admin')) return 'target-outranks-actor'
  // 收拢前那道阶梯的第三步，逐字搬过来。它今天走不到：自己对自己角色必然相同，上面两条必有
  // 一条先命中（基线里「管理员踢自己」返回的正是上一句）。留着是因为删掉它就等于删掉
  // 「不能对自己执行某个操作」这条规则本身，而那不是本轮的判定。
  return actor.participantId === target.participantId ? 'target-is-actor' : undefined
}

export function createRelationshipActions({
  commitSceneMutation,
  dispatchGroupNotice,
  removeGroupMember,
  removeRelationshipRequest,
  addFriendship,
  addApprovedGroupMember,
}: RelationshipActionCollaborators): RelationshipActions {
  return {
    async leaveGroup({ group, actor }) {
      if (actor.role === 'owner') return 'owner-cannot-leave'
      await dispatchGroupNotice(group, 'group_decrease', {
        sub_type: 'leave',
        operator_id: Number(actor.participantId),
        user_id: Number(actor.participantId),
      })
      removeGroupMember(group, actor.participantId)
    },

    async renameGroup({ group, actor, name }) {
      const denial = denyGroupAuthority(actor)
      if (denial) return denial
      // 空名校验必须在权限判定之后：普通成员传空名时该看到的是权限不足，而不是名称为空。
      const next = name.trim()
      if (!next) return 'group-name-empty'
      const previousName = group.name
      group.name = next
      commitSceneMutation()
      await dispatchGroupNotice(group, 'group_name', {
        user_id: Number(actor.participantId),
        name_old: previousName,
        name_new: group.name,
      })
    },

    async kickGroupMember({ group, actor, target }) {
      const denial = denyGroupMemberManagement(actor, target)
      if (denial) return denial
      // 通知在摘掉成员之前派发：被踢者此刻还在群里，事件里的群成员资料因此仍然解析得出。
      await dispatchGroupNotice(group, 'group_decrease', (botId) => ({
        sub_type: botId === target.participantId ? 'kick_me' : 'kick',
        operator_id: Number(actor.participantId),
        user_id: Number(target.participantId),
      }))
      removeGroupMember(group, target.participantId)
    },

    async setGroupAdmin({ group, actor, target, enabled }) {
      const denial = denyGroupOwnership(actor)
      if (denial) return denial
      if (target.role === 'owner') return 'target-is-owner'
      target.role = enabled ? 'admin' : 'member'
      commitSceneMutation()
      await dispatchGroupNotice(group, 'group_admin', {
        sub_type: enabled ? 'set' : 'unset',
        user_id: Number(target.participantId),
      })
    },

    async setGroupCard({ group, actor, target, card }) {
      if (target.participantId !== actor.participantId) {
        const denial = denyGroupMemberManagement(actor, target)
        if (denial) return denial
      }
      const previousCard = target.card ?? ''
      target.card = card.trim() || undefined
      commitSceneMutation()
      await dispatchGroupNotice(group, 'group_card', {
        user_id: Number(target.participantId),
        card_old: previousCard,
        card_new: target.card ?? '',
      })
    },

    async transferGroupOwner({ group, actor, target }) {
      const denial = denyGroupOwnership(actor)
      if (denial) return denial
      if (actor.participantId === target.participantId) return 'owner-transfer-to-self'
      actor.role = 'member'
      target.role = 'owner'
      commitSceneMutation()
      await dispatchGroupNotice(group, 'group_owner', {
        operator_id: Number(actor.participantId),
        user_id: Number(target.participantId),
        owner_id_old: Number(actor.participantId),
        owner_id_new: Number(target.participantId),
      })
    },

    // 专属头衔与禁言不派发群通知：真实 OneBot 实现也不为它们产生 notice，插件从群成员资料
    // 和禁言列表复查执行结果。因此这两个动作是同步的，入参里也没有群对象。
    setGroupMemberTitle({ actor, target, title }) {
      const denial = denyGroupOwnership(actor)
      if (denial) return denial
      const trimmed = title.trim()
      if (trimmed.length > MAX_GROUP_TITLE_LENGTH) return 'title-too-long'
      target.title = trimmed || undefined
      commitSceneMutation()
    },

    muteGroupMember({ actor, target, durationSeconds }) {
      // 时长先判：它不依赖角色，且时长非法时插件该看到的是时长问题而不是权限问题。
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return 'mute-duration-negative'
      if (durationSeconds > MAX_GROUP_MUTE_SECONDS) return 'mute-duration-too-long'
      const denial = denyGroupMemberManagement(actor, target)
      if (denial) return denial
      target.mutedUntil = durationSeconds > 0
        ? new Date(Date.now() + durationSeconds * 1000).toISOString()
        : undefined
      commitSceneMutation()
    },

    settleFriendRequest({ requestId, requesterId, targetId, approve, onApproved }) {
      removeRelationshipRequest(requestId)
      if (approve) {
        // 可选调用会跳过实参求值，好友关系因此必须先建立再交给补充回调。
        const friendship = addFriendship(requesterId, targetId)
        onApproved?.(friendship)
      }
      commitSceneMutation()
    },

    async settleGroupRequest({ group, requestId, participantId, operatorId, subType, approve }) {
      removeRelationshipRequest(requestId)
      // 批准时由加入成员那一步提交场景变更并派发入群通知；拒绝只剩摘掉申请这一处变更。
      if (approve) await addApprovedGroupMember({ group, participantId, operatorId, subType })
      else commitSceneMutation()
    },
  }
}
