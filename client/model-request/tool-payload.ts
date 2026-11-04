/**
 * 工具载荷该按结构显示还是按原文显示。
 *
 * 工具调用参数与工具结果在协议上都只是一段字符串，实际几乎总是 JSON：搜索结果、网页抓取正文、
 * 结构化返回值都从这里进来。原样铺开时整段结构挤成一行，字符串里的换行还停在 `\n` 转义上，
 * 三千字符的搜索结果因此只能逐字读。能解析成对象或数组时交给 JSON 查看器，其余仍按原文显示。
 */
export type ModelRequestToolPayload =
  | { kind: 'json', value: unknown }
  | { kind: 'text' }

export interface ModelRequestToolPayloadOptions {
  /**
   * 强制按原文显示。
   *
   * 搜索命中这张卡片时必须置为真：命中处的高亮由正文那棵 pre 画出来，结构视图里没有它，
   * 于是卡片会一边不被静音、一边看不出命中在哪。让命中的那几张退回原文，是唯一能同时
   * 保住「结构默认可读」和「搜索能指出位置」的形态。
   */
  revealText?: boolean
}

const TEXT_PAYLOAD: ModelRequestToolPayload = { kind: 'text' }

/**
 * 判定一段工具载荷文本的展示形态。
 *
 * 只认对象与数组两种开头。`JSON.parse` 同样接受 `123`、`true`、`"一段文本"` 这些标量，
 * 把它们摆成一棵单节点的树只是给纯文本套上一层括号；先看首字符也让整段纯文本的工具结果
 * 不必进 `JSON.parse` 就能判掉——那类结果动辄几十 KB，而这个判定每次重渲染都要问一遍。
 */
export function resolveModelRequestToolPayload(
  value: string | undefined,
  options: ModelRequestToolPayloadOptions = {},
): ModelRequestToolPayload {
  if (options.revealText) return TEXT_PAYLOAD
  const trimmed = value?.trim()
  if (!trimmed) return TEXT_PAYLOAD
  const opening = trimmed[0]
  if (opening !== '{' && opening !== '[') return TEXT_PAYLOAD
  try {
    const parsed = JSON.parse(trimmed) as unknown
    // 数组与对象都落在 typeof 'object' 上；null 只有在 `JSON.parse('{...}')` 之外才可能出现。
    if (!parsed || typeof parsed !== 'object') return TEXT_PAYLOAD
    return { kind: 'json', value: parsed }
  } catch {
    return TEXT_PAYLOAD
  }
}
