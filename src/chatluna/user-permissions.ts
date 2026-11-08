import type { Context } from 'cordis'
import type { PermissionRule } from '@chatluna/permission'
import type { SandboxUser } from '../types'

/**
 * 工具门禁按 actor/speakers 重建身份，不读取入站 Session 的 user 行。用户等级因此注册成权限服务的
 * 临时规则，只命中当前场景正在运行的沙盒机器人；不写平台用户表或全局 setLevel，避免影响真实账号。
 * 子作用域随 permissions 重载，场景与用户设置不跟着重建。等级未设置时完全沿用宿主权限。
 */
export function bindSandboxUserPermissions(ctx: Context, read: () => { users: SandboxUser[]; botIds: string[] }) {
  let refresh = () => {}
  const fiber = ctx.inject(['permissions'], (inner) => {
    let previous = ''
    const disposers: Array<() => void> = []
    const clear = () => { for (const dispose of disposers.splice(0)) dispose() }
    const sync = () => {
      const { users, botIds } = read()
      const assigned = users.flatMap(({ id, authority }) => authority === undefined ? [] : [{ id, authority }])
      const key = JSON.stringify([botIds, assigned])
      if (key === previous) return
      previous = key
      clear()
      if (!botIds.length) return
      for (const { id, authority } of assigned) {
        const when: PermissionRule['when'] = {
          kind: 'and',
          operands: [
            { kind: 'scope', field: 'platform', values: ['onebot'] },
            { kind: 'scope', field: 'self', values: botIds },
            { kind: 'scope', field: 'user', values: [id] },
          ],
        }
        const rule = (permission: string, effect: 'allow' | 'deny') => disposers.push(inner.permissions.rule({
          permission, effect, when, source: 'onebot-sandbox',
        }))
        if (authority === 0) {
          rule('*', 'deny')
          continue
        }
        rule(`authority:${authority}`, 'allow')
        // 宿主默认等级、主人或其他授权可能更高；逐级封顶，设置 1 级不能被默认的 2 级抬高。
        for (let level = authority + 1; level <= 5; level++) rule(`authority:${level}`, 'deny')
      }
    }
    refresh = sync
    inner.effect(() => () => {
      clear()
      refresh = () => {}
    })
    sync()
  })
  return {
    sync: () => refresh(),
    dispose: () => { void fiber.dispose() },
  }
}
