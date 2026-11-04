import { describe, expect, it } from 'vitest'
import { parsePresetSourceDocument } from '../src/presets'

describe('预设源文档', () => {
  it('从核心 YAML 的语义字段提取精确表达式范围，同时保留原始源码', () => {
    const source = `# keep this comment
name: demo
prompts:
  - role: system
    content: |-
      Hello {user.name}; {{literal}}; {format("}", nested(call(1)))}.
      {if enabled}{value}{elseif fallback}{else}{/if}
  - role: human
    content: plain {prompt}
format_user_prompt: 'Ask {prompt} and {{escaped}}'
unknown: { preserved: true }
`

    const document = parsePresetSourceDocument('core', source)

    expect(document.source).toBe(source)
    expect(document.diagnostics).toEqual([])
    expect(document.templateFields.map(({ path }) => path)).toEqual([
      ['prompts', 0, 'content'],
      ['prompts', 1, 'content'],
      ['format_user_prompt'],
    ])
    expect(document.expressions.map((expression) => ({
      path: expression.path,
      text: source.slice(expression.range.start, expression.range.end),
      content: expression.content,
      kind: expression.kind,
      clickable: expression.clickable,
      occurrence: expression.occurrence,
    }))).toEqual([
      { path: ['prompts', 0, 'content'], text: '{user.name}', content: 'user.name', kind: 'value', clickable: true, occurrence: 0 },
      { path: ['prompts', 0, 'content'], text: '{format("}", nested(call(1)))}', content: 'format("}", nested(call(1)))', kind: 'value', clickable: true, occurrence: 1 },
      { path: ['prompts', 0, 'content'], text: '{if enabled}', content: 'if enabled', kind: 'control', clickable: false, occurrence: 2 },
      { path: ['prompts', 0, 'content'], text: '{value}', content: 'value', kind: 'value', clickable: true, occurrence: 3 },
      { path: ['prompts', 0, 'content'], text: '{elseif fallback}', content: 'elseif fallback', kind: 'control', clickable: false, occurrence: 4 },
      { path: ['prompts', 0, 'content'], text: '{else}', content: 'else', kind: 'control', clickable: false, occurrence: 5 },
      { path: ['prompts', 0, 'content'], text: '{/if}', content: '/if', kind: 'control', clickable: false, occurrence: 6 },
      { path: ['prompts', 1, 'content'], text: '{prompt}', content: 'prompt', kind: 'value', clickable: true, occurrence: 0 },
      { path: ['format_user_prompt'], text: '{prompt}', content: 'prompt', kind: 'value', clickable: true, occurrence: 0 },
    ])
  })

  it('只读取 Character 的 system 与 input，并识别循环控制标签和嵌套花括号', () => {
    const source = `name: character
system: "System {profile.name}"
input: |-
  {for item in items}{render({item}, 'quoted } brace')}{/for}
  {while active}{repeat count}{item}{/repeat}{/while}
status: "not a {template_field}"
`

    const document = parsePresetSourceDocument('character', source)

    expect(document.templateFields.map(({ path }) => path)).toEqual([
      ['system'],
      ['input'],
    ])
    expect(document.expressions.map((expression) => ({
      text: source.slice(expression.range.start, expression.range.end),
      kind: expression.kind,
      clickable: expression.clickable,
    }))).toEqual([
      { text: '{profile.name}', kind: 'value', clickable: true },
      { text: '{for item in items}', kind: 'control', clickable: false },
      { text: "{render({item}, 'quoted } brace')}", kind: 'value', clickable: true },
      { text: '{/for}', kind: 'control', clickable: false },
      { text: '{while active}', kind: 'control', clickable: false },
      { text: '{repeat count}', kind: 'control', clickable: false },
      { text: '{item}', kind: 'value', clickable: true },
      { text: '{/repeat}', kind: 'control', clickable: false },
      { text: '{/while}', kind: 'control', clickable: false },
    ])
  })

  it('按 YAML CST 映射 plain 与引号标量的换行折叠、CRLF、转义和 Unicode 码点', () => {
    const source = [
      'name: character',
      'system: plain {first}',
      '  continued {second}',
      '',
      '  after {third}',
      'input: "😀 \\U0001F642 {unicode} and {line',
      '  folded} then \\u007Bescaped\\u007D"',
      '',
    ].join('\r\n')

    const document = parsePresetSourceDocument('character', source)

    expect(document.diagnostics).toEqual([])
    expect(document.expressions.map((expression) => ({
      text: source.slice(expression.range.start, expression.range.end),
      content: expression.content,
    }))).toEqual([
      { text: '{first}', content: 'first' },
      { text: '{second}', content: 'second' },
      { text: '{third}', content: 'third' },
      { text: '{unicode}', content: 'unicode' },
      { text: '{line\r\n  folded}', content: 'line folded' },
    ])
    for (const expression of document.expressions) {
      const text = source.slice(expression.range.start, expression.range.end)
      expect(text.startsWith('{')).toBe(true)
      expect(text.endsWith('}')).toBe(true)
    }
  })

  it('按 YAML CST 映射单引号折叠和 literal/folded block 的缩进、chomping 与较深缩进', () => {
    const source = [
      'name: character',
      "system: 'before ''quoted'' {first}",
      "  and {line",
      "  folded}'",
      'input: >2+',
      '    {block}',
      '      more {indented}',
      '',
      '    {after-blank}',
      '',
      'unused: |4-',
      '      literal {ignored}',
      '',
    ].join('\r\n')

    const document = parsePresetSourceDocument('character', source)

    expect(document.diagnostics).toEqual([])
    expect(document.expressions.map((expression) => ({
      text: source.slice(expression.range.start, expression.range.end),
      content: expression.content,
    }))).toEqual([
      { text: '{first}', content: 'first' },
      { text: '{line\r\n  folded}', content: 'line folded' },
      { text: '{block}', content: 'block' },
      { text: '{indented}', content: 'indented' },
      { text: '{after-blank}', content: 'after-blank' },
    ])
  })

  it('映射 literal block 的显式缩进和 strip chomping，且不把转义花括号报告成可点击源码范围', () => {
    const source = [
      'name: character',
      'system: "\\u007Bnot-source-braces\\u007D {literal-braces}"',
      'input: |4-',
      '      leading {one}',
      '      next {two}',
      '',
    ].join('\r\n')

    const document = parsePresetSourceDocument('character', source)

    expect(document.expressions.map((expression) => ({
      text: source.slice(expression.range.start, expression.range.end),
      content: expression.content,
    }))).toEqual([
      { text: '{literal-braces}', content: 'literal-braces' },
      { text: '{one}', content: 'one' },
      { text: '{two}', content: 'two' },
    ])
  })

  it('返回 YAML 与模板字段诊断，而不把非字符串字段当成模板', () => {
    const wrongType = parsePresetSourceDocument('character', `system: [not, text]\ninput: ok {prompt}\n`)
    expect(wrongType.expressions.map(({ content }) => content)).toEqual(['prompt'])
    expect(wrongType.diagnostics).toContainEqual(expect.objectContaining({
      code: 'template-field-not-string',
      path: ['system'],
      severity: 'error',
    }))

    const malformedYaml = parsePresetSourceDocument('core', `prompts:\n  - content: "unterminated\n`)
    expect(malformedYaml.diagnostics).toContainEqual(expect.objectContaining({
      code: 'yaml-parse-error',
      severity: 'error',
    }))
  })

  it('把展示名称当作解析产物交出：核心预设取第一个关键词，Character 预设取名称字段', () => {
    expect(parsePresetSourceDocument('core', `keywords:\n  - first\n  - second\nprompts: []\n`).displayName).toBe('first')
    expect(parsePresetSourceDocument('character', `name: Alice\nsystem: hi\ninput: there\n`).displayName).toBe('Alice')

    expect(parsePresetSourceDocument('core', 'prompts: []\n').displayName).toBeUndefined()
    expect(parsePresetSourceDocument('core', `keywords: []\nprompts: []\n`).displayName).toBeUndefined()
    expect(parsePresetSourceDocument('core', `keywords:\n  - "   "\nprompts: []\n`).displayName).toBeUndefined()
    expect(parsePresetSourceDocument('core', `keywords:\n  - 42\nprompts: []\n`).displayName).toBeUndefined()
    expect(parsePresetSourceDocument('core', `keywords: not-a-list\nprompts: []\n`).displayName).toBeUndefined()
    expect(parsePresetSourceDocument('character', 'system: hi\ninput: there\n').displayName).toBeUndefined()
    expect(parsePresetSourceDocument('character', `name: "  "\nsystem: hi\n`).displayName).toBeUndefined()
  })

  it('展示名称的缺失判定与文档诊断一致：只有 YAML 语法错误才没有展示名称', () => {
    const malformed = parsePresetSourceDocument('core', `keywords:\n  - broken\nprompts:\n  - content: "unterminated\n`)
    expect(malformed.diagnostics.some(({ code }) => code === 'yaml-parse-error')).toBe(true)
    expect(malformed.displayName).toBeUndefined()

    // 模板字段类型诊断不是解析失败：文档仍然可读，展示名称照旧交出。
    const wrongTemplateType = parsePresetSourceDocument('character', `name: Alice\nsystem: [not, text]\ninput: ok\n`)
    expect(wrongTemplateType.diagnostics.some(({ code }) => code === 'template-field-not-string')).toBe(true)
    expect(wrongTemplateType.diagnostics.some(({ code }) => code === 'yaml-parse-error')).toBe(false)
    expect(wrongTemplateType.displayName).toBe('Alice')
  })
})
