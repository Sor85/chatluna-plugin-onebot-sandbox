import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 客户端全部样式源码的观察面。
 *
 * 区域样式表按能力归属散进了 `client/<能力>/`（ADR-0090），因此「全仓样式表」不再等于
 * 「`client/styles/` 下的文件」。凡是按目录扫样式的守卫都必须走这里：留在原地读
 * `client/styles/` 的扫描不会报错，只会静默缩小到剩下的几张跨能力表，而那正是它要拦的东西
 * 搬走之后的形态。
 *
 * `tailwind.generated.css` 是构建产物而不是源码，一律排除。
 */
export function listClientStylesheets(directory = 'client'): string[] {
  return readdirSync(resolve(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listClientStylesheets(path)
    if (!entry.name.endsWith('.css') || entry.name.endsWith('.generated.css')) return []
    return [path]
  }).sort()
}

/** 同上，直接返回内容；顺序按路径排序，与 `listClientStylesheets()` 一致。 */
export function readClientStylesheets(): string[] {
  return listClientStylesheets().map((path) => readFileSync(resolve(path), 'utf8'))
}

/**
 * 单文件组件的模板源码。
 *
 * 有一类不变量只能把模板和样式对着看才判定得出来：类名落在哪种元素上决定了它要跟谁抢级联
 * （例如 shadcn 控件自带 Tailwind 工具类），单看样式表看不出这层关系。
 */
export function readClientTemplates(directory = 'client'): { path: string, source: string }[] {
  return readdirSync(resolve(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return readClientTemplates(path)
    if (!entry.name.endsWith('.vue')) return []
    const template = readFileSync(resolve(path), 'utf8').match(/<template>([\s\S]*)<\/template>/)
    return template ? [{ path, source: template[1]! }] : []
  }).sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * 单文件组件里 `<style>` 块的源码，标注成 `路径#序号`。
 *
 * 这一面不在 `listClientStylesheets()` 里：那份只扫 `.css`。scoped 块编译后仍然进同一张产物表，
 * 选择器写错一样会漏到宿主页面上，所以凡是判定「有没有越出本插件表面」的守卫都要把组件样式也扫上，
 * 否则违规规则藏在 `.vue` 里永远拦不住。
 */
export function readClientStyleBlocks(directory = 'client'): { path: string, source: string }[] {
  return readdirSync(resolve(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return readClientStyleBlocks(path)
    if (!entry.name.endsWith('.vue')) return []
    return [...readFileSync(resolve(path), 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((match, index) => ({ path: `${path}#${index}`, source: match[1]! }))
  }).sort((left, right) => left.path.localeCompare(right.path))
}
