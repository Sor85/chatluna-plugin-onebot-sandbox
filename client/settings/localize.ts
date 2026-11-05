import type { Translate } from '@chatluna/ui-client/client'
import type { SchemaDocument, SchemaDocumentNode } from '@chatluna/schema'

/** schema 文案的键前缀，后接节点的文案 ID 与 `label`/`description`。 */
export const SCHEMA_LOCALE_PREFIX = 'sandbox.settings.schema.'

const TEXT_FIELDS = ['label', 'description'] as const

/** 一个带文案的 schema 节点：文案 ID 与服务端写在 schema 里的中文原文。 */
export interface SchemaText {
  id: string
  field: typeof TEXT_FIELDS[number]
  text: string
}

/**
 * 按配置路径给 schema 节点分配文案 ID：字段用点分路径（`testEndpoint.shared.host`），单选项用
 * `<路径>.option.<值>`。分区与小节没有自己的配置键（intersect 成员与所在字段共用路径），在 `src/index.ts`
 * 里用 `extra('i18n', 'group.<名称>')` 显式起名；没起名的 intersect 成员不翻译，免得与所在字段撞键。
 */
function visit(document: SchemaDocument, id: number, textId: string | undefined, path: string, found: (id: number, textId: string) => void) {
  const node = document.refs[id]
  if (!node) return
  const named = (node.meta as { i18n?: unknown } | undefined)?.i18n
  const own = typeof named === 'string' ? named : textId
  if (own) found(id, own)
  if (node.type === 'object') {
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      const childPath = path ? `${path}.${key}` : key
      visit(document, child, childPath, childPath, found)
    }
  } else if (node.type === 'intersect') {
    for (const child of node.list ?? []) visit(document, child, undefined, path, found)
  } else if (node.type === 'union') {
    for (const child of node.list ?? []) {
      const option = document.refs[child]
      if (option?.type === 'const') visit(document, child, `${path}.option.${String(option.value)}`, path, found)
    }
  }
}

/** 列出 schema 里全部待翻译的文案，供测试核对两份语言文件。 */
export function schemaTexts(document: SchemaDocument): SchemaText[] {
  const texts: SchemaText[] = []
  visit(document, document.uid, undefined, '', (id, textId) => {
    const meta = document.refs[id]?.meta ?? {}
    for (const field of TEXT_FIELDS) {
      const text = meta[field]
      if (typeof text === 'string' && text) texts.push({ id: textId, field, text })
    }
  })
  return texts
}

/**
 * v2 SchemaForm 只接受字符串形式的 `label`/`description`，没有多语言；这里在交给表单前按当前语言替换文案。
 * 语言文件里缺的键原样保留服务端的中文，新增字段忘了补译文时不会显示成键名。
 */
export function localizeSchema(document: SchemaDocument, t: Translate): SchemaDocument {
  const refs: Record<string, SchemaDocumentNode> = { ...document.refs }
  visit(document, document.uid, undefined, '', (id, textId) => {
    const node = refs[id]!
    const meta = { ...node.meta }
    for (const field of TEXT_FIELDS) {
      if (typeof meta[field] !== 'string' || !meta[field]) continue
      const key = `${SCHEMA_LOCALE_PREFIX}${textId}.${field}`
      const translated = t(key)
      if (translated !== key) meta[field] = translated
    }
    refs[id] = { ...node, meta }
  })
  return { uid: document.uid, refs }
}
