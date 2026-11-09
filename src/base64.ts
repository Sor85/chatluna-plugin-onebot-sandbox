/** 校验完整的标准 Base64，避免重复分组正则在大附件上耗尽调用栈。 */
export function isBase64(value: string): boolean {
  if (!value.length || value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))
}
