#!/usr/bin/env node
// 把插件源码单向同步到 ChatLuna v2 开发仓库的 external/onebot-sandbox。
//
// 本仓库是插件的唯一源码；v2 那份只是工作区成员副本，供 yarn workspace 解析 @chatluna/*、
// 构建与 dev 实例加载。构建产物与依赖只存在于副本里，因此同步不碰它们。
//
// 用法：
//   node scripts/sync-to-v2.mjs          同步一次后持续监听
//   node scripts/sync-to-v2.mjs --once   只同步一次
// v2 仓库位置默认是相对本仓库的 ../../chatluna-v2-mirror，可用环境变量 CHATLUNA_V2_ROOT 覆盖。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const v2Root = path.resolve(process.env.CHATLUNA_V2_ROOT ?? path.join(source, '..', '..', 'chatluna-v2-mirror'))
const target = path.join(v2Root, 'external', 'onebot-sandbox')

// 只在副本里存在、同步时既不覆盖也不删除的路径（相对插件根目录的第一段）。
const KEEP_IN_TARGET = new Set(['node_modules', 'lib', 'dist', 'data', '.git'])
const IGNORED_NAMES = new Set(['.DS_Store'])
const isIgnored = (relative) => {
  const [head] = relative.split(path.sep)
  const name = path.basename(relative)
  return KEEP_IN_TARGET.has(head) || IGNORED_NAMES.has(name) || name.endsWith('.tsbuildinfo')
}

if (fs.realpathSync(source) === (fs.existsSync(target) ? fs.realpathSync(target) : '')) {
  console.error('[sync] 源目录与目标目录相同，这份副本不是源码仓库。')
  process.exit(1)
}
if (!fs.existsSync(path.join(v2Root, 'package.json'))) {
  console.error(`[sync] 未找到 ChatLuna v2 仓库：${v2Root}（可设置 CHATLUNA_V2_ROOT）`)
  process.exit(1)
}

function list(root) {
  const files = new Map()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute)
      if (isIgnored(relative)) continue
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.set(relative, fs.statSync(absolute))
    }
  }
  if (fs.existsSync(root)) walk(root)
  return files
}

function sync() {
  const from = list(source)
  const to = list(target)
  let copied = 0
  let removed = 0
  for (const [relative, stat] of from) {
    const existing = to.get(relative)
    // utimes 写入时间戳会丢失亚毫秒精度（取整或舍入），差值小于 1ms 视为同一时刻。
    if (existing && existing.size === stat.size && Math.abs(existing.mtimeMs - stat.mtimeMs) < 1) continue
    const destination = path.join(target, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(source, relative), destination)
    // 保留源文件时间戳，下一轮按大小与时间比较即可跳过未改动的文件。
    fs.utimesSync(destination, stat.atime, stat.mtime)
    copied++
  }
  for (const relative of to.keys()) {
    if (from.has(relative)) continue
    fs.rmSync(path.join(target, relative))
    removed++
  }
  removeEmptyDirs(target)
  return { copied, removed }
}

function removeEmptyDirs(dir, root = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const absolute = path.join(dir, entry.name)
    if (isIgnored(path.relative(root, absolute))) continue
    removeEmptyDirs(absolute, root)
    if (!fs.readdirSync(absolute).length) fs.rmdirSync(absolute)
  }
}

function report(reason) {
  const { copied, removed } = sync()
  if (copied || removed || reason === 'initial') {
    console.log(`[sync] ${new Date().toLocaleTimeString()} ${reason}：复制 ${copied}，删除 ${removed} → ${target}`)
  }
}

report('initial')
if (process.argv.includes('--once')) process.exit(0)

// 编辑器保存一次常触发多个事件，合并 100ms 内的变化再同步。
let timer
fs.watch(source, { recursive: true }, (_event, filename) => {
  if (filename && isIgnored(String(filename))) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    try {
      report('change')
    } catch (error) {
      console.error('[sync] 同步失败', error)
    }
  }, 100)
})
console.log(`[sync] 监听 ${source}`)
