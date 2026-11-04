/**
 * 右键菜单关闭时的焦点交接。
 *
 * reka-ui 的菜单在卸载时会把焦点还给「右键之前那个元素」。消息气泡不可聚焦，所以那个元素
 * 常常是 `document.body`；Firefox 还会在右键时聚焦头像与成员行这类按钮，于是焦点被还给按钮。
 * 「回复」「@ 用户」这类要求用户继续打字的菜单项，若在菜单关闭前就把焦点交给输入框，还焦会
 * 立刻把它收回，表现为回复条或提及已经出现但输入框里没有光标。
 *
 * 因此让位必须发生在菜单自己的还焦时机上，并且只针对这一次关闭：无条件阻止还焦，会让「撤回」
 * 「贴表情」这些不接管焦点的菜单项也丢掉用户原来的焦点（常常正是输入框）。
 */
export interface MenuFocusHandoff {
  /** 记下「这个菜单里的某一项要把焦点交出去」。 */
  request(targetId: string): void
  /**
   * 菜单还焦前问一次：这次该不该让位。
   *
   * 按菜单标识比对而不是只看有没有待交接的意图：同一条消息上挂着气泡与头像两个菜单，退场动画
   * 期间也可能有两个菜单同时在场，先关的那个不能把另一个刚记下的意图消费掉。命中即清空，
   * 同一个意图只让位一次。
   */
  consume(targetId: string): boolean
}

export function createMenuFocusHandoff(): MenuFocusHandoff {
  /** 待交接意图所属的菜单标识；空串表示这次关闭没人接管焦点。 */
  let pendingTargetId = ''

  return {
    request(targetId: string) {
      pendingTargetId = targetId
    },
    consume(targetId: string) {
      if (!targetId || pendingTargetId !== targetId) return false
      pendingTargetId = ''
      return true
    },
  }
}
