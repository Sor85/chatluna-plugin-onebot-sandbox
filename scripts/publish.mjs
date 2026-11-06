#!/usr/bin/env node
// 本地构建并发布到 npm。
//
// 插件依赖的 @chatluna/* 只存在于 ChatLuna v2 仓库（私有、未发布到 npm），CI 拿不到，
// 所以发布在本机完成：同步到 v2 副本、清空旧产物后构建与测试、yarn pack 打包，再 npm publish 这个包，
// 最后给当前提交打 v<版本> tag 并推送。
//
// 用法：
//   node scripts/publish.mjs            发布 package.json 里的版本
//   node scripts/publish.mjs --dry-run  走完构建、测试与打包，只执行 npm publish --dry-run，不打 tag
// v2 仓库位置与 sync-to-v2.mjs 相同：默认 ../../chatluna-v2-mirror，可用 CHATLUNA_V2_ROOT 覆盖。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const v2Root = path.resolve(process.env.CHATLUNA_V2_ROOT ?? path.join(source, '..', '..', 'chatluna-v2-mirror'))
const target = path.join(v2Root, 'external', 'onebot-sandbox')
const dryRun = process.argv.includes('--dry-run')

const run = (command, args, cwd = source) => execFileSync(command, args, { cwd, stdio: 'inherit' })
const read = (command, args, cwd = source) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()
const fail = (message) => {
  console.error(`[publish] ${message}`)
  process.exit(1)
}

const { name, version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
const tag = `v${version}`

// 发布的内容必须就是某个已推送的提交：工作区有改动时，包里的代码对不上 tag。
if (read('git', ['status', '--porcelain'])) fail('工作区有未提交的改动，先提交或还原')
if (read('git', ['tag', '--list', tag])) fail(`tag ${tag} 已存在，先修改 package.json 的 version`)
if (!dryRun) {
  read('git', ['fetch', 'origin', '--quiet'])
  const branch = read('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (read('git', ['rev-list', '--count', `origin/${branch}..HEAD`]) !== '0') fail('当前分支有未推送的提交，先 git push')
  try {
    read('npm', ['whoami'])
  } catch {
    fail('npm 未登录，先运行 npm login')
  }
}

console.log(`[publish] ${name}@${version}${dryRun ? '（演练）' : ''}`)
run('node', [path.join(source, 'scripts', 'sync-to-v2.mjs'), '--once'])

// 同步脚本不清理 lib/dist，副本里会残留已删除模块的产物，打包前必须清空后重新构建。
// tsbuildinfo 一并删除：它还在时 tsc 认为产物已是最新，清空 lib 后不再生成类型声明。
for (const entry of ['lib', 'dist', 'tsconfig.tsbuildinfo']) fs.rmSync(path.join(target, entry), { recursive: true, force: true })
run('yarn', ['yakumo', 'build', 'onebot-sandbox'], v2Root)
run(path.join(v2Root, 'node_modules', '.bin', 'vitest'), ['run'], target)

// yarn pack 把 workspace:* 改写成具体版本，npm pack 不会。
const tarball = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-sandbox-')), 'package.tgz')
run('yarn', ['pack', '--out', tarball], target)

const args = ['publish', tarball, '--access', 'public']
const prerelease = version.match(/-(alpha|beta|rc|next)/)?.[1]
if (prerelease) args.push('--tag', prerelease)
if (dryRun) args.push('--dry-run')
run('npm', args)

if (dryRun) {
  console.log(`[publish] 演练完成，包文件：${tarball}`)
  process.exit(0)
}

run('git', ['tag', tag])
run('git', ['push', 'origin', tag])
console.log(`[publish] 已发布 ${name}@${version}，tag ${tag} 已推送`)
