import { expect } from 'vitest'

/**
 * 用户可见文案断言的显式出口（ADR 0073 的第二类例外）。
 *
 * 在不引入组件挂载测试、jsdom 或 happy-dom 的前提下，「界面上这句话还在不在」没有别的观察面，
 * 因此这类源码文本断言是允许的。但它和被禁止的肯定式实现细节断言长得一模一样——都是
 * `expect(source).toContain(...)`——规则无从按形状区分两者。
 *
 * 把它写成一个具名函数，等于把「这条断言保护的是用户可见文案」这个意图写进代码形状：
 * 守卫规则因此能按形状判定合法出口，而不必靠人维护一张断言级别的白名单。
 *
 * 仅限界面上真会被用户读到的字面文案。类名、属性名、类型声明、函数名、CSS 选择器都不是文案，
 * 借这个出口把它们塞进来会让规则退化成一句空话。
 */
export function expectUserFacingCopy(source: string, copy: string, hint?: string) {
  expect(source, hint ?? `缺少用户可见文案：${copy}`).toContain(copy)
}

/** 同上，用于一次断言多条相邻文案。 */
export function expectUserFacingCopies(source: string, copies: readonly string[], hint?: string) {
  for (const copy of copies) expectUserFacingCopy(source, copy, hint)
}
