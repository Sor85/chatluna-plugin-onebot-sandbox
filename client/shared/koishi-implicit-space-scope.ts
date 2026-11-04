/**
 * 隐式定域：适配器按当前活动的 AI 测试空间给请求补 `spaceId`。
 *
 * 两道定域的端口（工作区、OneBot 调试记录）共用这一份实现而不是各抄一遍：「显式定域优先」
 * 是一条规则而不是两条，抄成两份之后其中一份被改动不会有任何红灯。
 */
export function createImplicitSpaceScope(resolveSpaceId: () => string | undefined) {
  return <Input extends object>(input: Input): Input & { spaceId?: string } => {
    const explicit = (input as { spaceId?: string }).spaceId
    // 显式定域优先：调用方已经指名 spaceId 时不得被当前活动空间覆盖。
    if (explicit !== undefined) return input as Input & { spaceId?: string }
    const spaceId = resolveSpaceId()
    return spaceId ? { ...input, spaceId } : input
  }
}
