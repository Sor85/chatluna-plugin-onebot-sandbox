export const SANDBOX_EXTENSION_DESCRIPTION = '非 OneBot action，仅用于构造测试场景'

export const sandboxExtensionActions = [
  'request-friend',
  'set-friend-remark',
  'request-join-group',
  'invite-group-member',
  'transfer-group-owner',
  'edit-environment-entity',
  'delete-environment-entity',
] as const

export type SandboxExtensionAction = typeof sandboxExtensionActions[number]

const sandboxExtensionActionSet = new Set<string>(sandboxExtensionActions)

// 这里只登记 WebUI 暴露、但不在 OneBot action 能力矩阵中的状态变更；
// Koishi 通用机器人 API 或单个实现是否支持，不改变“沙盒扩展”的判断。
export function isSandboxExtensionAction(action: string): action is SandboxExtensionAction {
  return sandboxExtensionActionSet.has(action)
}
