import { SandboxDomainError, type SandboxSnapshot, type SandboxUserAuthority } from './types'

/** 所有写入口共用：省略或 null 表示不覆盖宿主等级，0 是有效的禁用等级。 */
export function normalizeUserAuthority(value: unknown): SandboxUserAuthority | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5) return value
  throw new SandboxDomainError('用户权限等级必须是 0 到 5 的整数')
}

/** 未设置表示沿用宿主等级；导入与恢复都校验，不能通过整块快照绕过写入口。 */
export function normalizeSceneUserAuthorities(snapshot: SandboxSnapshot): void {
  for (const participant of snapshot.participants) {
    if (participant.kind !== 'user') continue
    const authority = normalizeUserAuthority(participant.authority)
    if (authority === undefined) delete participant.authority
    else participant.authority = authority
  }
}
