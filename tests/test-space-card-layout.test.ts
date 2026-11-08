import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../client/test-space/spaces.css', import.meta.url), 'utf8')

describe('测试空间卡片布局', () => {
  it('内部网格列允许收缩，长标题不会把操作区挤出卡片', () => {
    const card = styles.match(/^\.sandbox-space-card\s*\{([^}]*)\}/m)?.[1]
    expect(card).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  it('操作区保留完整宽度，不随标题收缩', () => {
    const actions = styles.match(/^\.sandbox-space-card-actions\s*\{([^}]*)\}/m)?.[1]
    expect(actions).toMatch(/flex:\s*none/)
  })
})
