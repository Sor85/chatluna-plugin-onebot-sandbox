import type { SandboxImplementationProfile } from '../../src/types'

/** 可选的 OneBot 实现配置，顺序即选择框里的顺序；名称是产品名，不翻译。 */
export const implementationOptions: Array<{ value: SandboxImplementationProfile, label: string }> = [
  { value: 'napcat', label: 'NapCat' },
  { value: 'llbot', label: 'LLBot' },
  { value: 'snowluma', label: 'SnowLuma' },
]

export function implementationLabel(value: SandboxImplementationProfile): string {
  return implementationOptions.find((option) => option.value === value)?.label ?? value
}
