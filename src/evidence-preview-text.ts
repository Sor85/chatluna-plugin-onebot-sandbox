/**
 * 证据预览文本的空白归一化。
 *
 * 轨迹账本行和分析导航条目都只显示一两百字的预览，但它们的输入是原始请求消息，
 * 单条动辄几十 KB。对整段文本跑一次 `\s+` 归一化，是这两条读取路径里最贵的一步，
 * 而结果的 99% 会被立刻丢掉。
 *
 * 这里只归一化足够产出预览的前缀，并在空白折叠让前缀不够长时继续扩大扫描范围。
 * 空白折叠是就地、保序的变换，因此前缀的归一化结果一定是整段归一化结果的前缀：
 * 返回值长度超过 `minLength` 时，它与整段归一化结果的前 `minLength` 个字符一致；
 * 没超过时两者完全相同。调用方按自己的规则截断。
 */

const SCAN_CHUNK = 4096
const SCAN_GROWTH = 4

export function normalizeEvidencePreviewText(value: string, minLength: number): string {
  let scan = Math.min(value.length, Math.max(minLength * SCAN_GROWTH, SCAN_CHUNK))
  let normalized = normalize(value, scan)
  while (normalized.length <= minLength && scan < value.length) {
    scan = Math.min(value.length, scan * SCAN_GROWTH)
    normalized = normalize(value, scan)
  }
  return normalized
}

function normalize(value: string, scan: number): string {
  return (scan >= value.length ? value : value.slice(0, scan)).replace(/\s+/g, ' ').trim()
}
