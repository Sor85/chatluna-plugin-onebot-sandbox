import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { schemaDocument } from '@chatluna/schema'
import { Settings } from '../src'
import { localizeSchema, SCHEMA_LOCALE_PREFIX, schemaTexts } from '../client/settings/localize'

/** 语言文件是一行一条的 `键: "值"`，值按 JSON 字符串解析。 */
function readLocale(name: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of readFileSync(resolve('client/locales', `${name}.yml`), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const match = /^([\w.-]+): (".*")$/.exec(line)
    if (!match) throw new Error(`无法解析的语言文件行：${line}`)
    entries.set(match[1]!, JSON.parse(match[2]!))
  }
  return entries
}

const document = schemaDocument(Settings)
const texts = schemaTexts(document)
const keyOf = ({ id, field }: { id: string, field: string }) => `${SCHEMA_LOCALE_PREFIX}${id}.${field}`
const locales = { zh: readLocale('zh'), en: readLocale('en') }

/**
 * 设置页的字段文案写在 `src/index.ts` 的 schema 里，界面按当前语言换成 `sandbox.settings.schema.` 下的文案
 * （`client/settings/localize.ts`）。改了 schema 文案或增删字段却没同步语言文件，设置页会在一种语言下
 * 退回中文原文或显示过期译文，别的测试不会变红。
 */
describe('设置页 schema 文案', () => {
  it('每条文案都有唯一的文案键', () => {
    const keys = texts.map(keyOf)
    expect(keys.length).toBeGreaterThan(50)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('中文语言文件与 schema 原文一致，英文语言文件都有译文', () => {
    for (const text of texts) {
      expect(locales.zh.get(keyOf(text)), keyOf(text)).toBe(text.text)
      expect(locales.en.get(keyOf(text)), keyOf(text)).toMatch(/\S/)
    }
  })

  it('语言文件里没有已失效的文案键', () => {
    const keys = new Set(texts.map(keyOf))
    for (const [name, entries] of Object.entries(locales)) {
      const stale = [...entries.keys()].filter((key) => key.startsWith(SCHEMA_LOCALE_PREFIX) && !keys.has(key))
      expect(stale, name).toEqual([])
    }
  })

  it('按当前语言替换文案，缺少译文时保留原文', () => {
    const en = locales.en
    const localized = localizeSchema(document, (key) => key.endsWith('.host.label') ? key : en.get(key) ?? key)
    const after = new Map(schemaTexts(localized).map((text) => [keyOf(text), text.text]))
    expect(after.get(`${SCHEMA_LOCALE_PREFIX}group.appearance.label`)).toBe(en.get(`${SCHEMA_LOCALE_PREFIX}group.appearance.label`))
    expect(after.get(`${SCHEMA_LOCALE_PREFIX}persistenceMode.option.memory.description`)).toBe(en.get(`${SCHEMA_LOCALE_PREFIX}persistenceMode.option.memory.description`))
    expect(after.get(`${SCHEMA_LOCALE_PREFIX}testEndpoint.shared.host.label`)).toBe('监听地址')
    // 原文档由服务端缓存（`schemaDocument`），替换只能产出新节点。
    expect(schemaTexts(document).map((text) => text.text)).toEqual(texts.map((text) => text.text))
  })
})
