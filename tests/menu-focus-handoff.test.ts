import { describe, expect, it } from 'vitest'
import { createMenuFocusHandoff } from '../client/webqq/menu-focus-handoff'

describe('右键菜单的焦点交接', () => {
  /** 按 Escape 或点空白关掉菜单时没人接管焦点，还焦必须照常执行。 */
  it('没有待交接的意图时不让位', () => {
    const handoff = createMenuFocusHandoff()

    expect(handoff.consume('m1')).toBe(false)
  })

  it('记下意图后，同一个菜单关闭时让位', () => {
    const handoff = createMenuFocusHandoff()

    handoff.request('m1')

    expect(handoff.consume('m1')).toBe(true)
  })

  /**
   * 让位只发生一次。菜单在同一次会话里可能被重新打开又直接关掉，那次关闭已经没人接管焦点；
   * 意图留着不清会让还焦一直被吞掉，表现为此后关菜单都丢焦点。
   */
  it('同一个意图只让位一次', () => {
    const handoff = createMenuFocusHandoff()

    handoff.request('m1')
    handoff.consume('m1')

    expect(handoff.consume('m1')).toBe(false)
  })

  /**
   * 同一条消息上挂着气泡与头像两个菜单，退场动画期间右键另一条消息时也会有两个菜单同时在场。
   * 先关的那个不得消费这次意图，否则它会把另一个菜单刚拿到的焦点抢给输入框。
   */
  it('别的菜单关闭不消费这次意图', () => {
    const handoff = createMenuFocusHandoff()

    handoff.request('m1')

    expect(handoff.consume('m2')).toBe(false)
    expect(handoff.consume('m1')).toBe(true)
  })

  /** 菜单标识由调用方给（消息 id、头像菜单前缀、成员 id）；读不到标识时一律不让位。 */
  it('菜单标识为空时不让位', () => {
    const handoff = createMenuFocusHandoff()

    handoff.request('')

    expect(handoff.consume('')).toBe(false)
  })
})
