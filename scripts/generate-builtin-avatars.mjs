#!/usr/bin/env node
// SVG 是可维护源，PNG 是随包分发的产物；只在改头像时运行，不在插件启动或普通构建时渲染。
// 本仓库没有 node_modules，生成器从 v2 workspace 读取开发依赖。
// 用法：node scripts/generate-builtin-avatars.mjs [--check]

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BUILTIN_AVATARS } from '../src/builtin-avatar-options.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const v2Root = path.resolve(process.env.CHATLUNA_V2_ROOT ?? path.join(root, '..', '..', 'chatluna-v2-mirror'))
const require = createRequire(path.join(v2Root, 'external/onebot-sandbox/package.json'))
const { Resvg } = require('@resvg/resvg-js')
const output = path.join(root, 'src/builtin-avatar-png.ts')
const previous = existsSync(output) ? (await import(pathToFileURL(output).href)).BUILTIN_AVATARS : {}
const referenceOf = (bytes) => `sandbox-media://${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`
const lines = [
  '// 由 scripts/generate-builtin-avatars.mjs 生成；修改 builtin-avatar-options.ts 后重新生成，不手工编辑 PNG。',
  "import type { BuiltinAvatarKind } from './builtin-avatar-options'",
  "export type { BuiltinAvatarKind } from './builtin-avatar-options'",
  '',
  `export const BUILTIN_AVATAR_SOURCE_HASH = '${createHash('sha256').update(JSON.stringify(BUILTIN_AVATARS)).digest('hex')}'`,
  '',
  'export interface BuiltinAvatar {',
  '  id: string',
  '  kind: BuiltinAvatarKind',
  '  png: string',
  '  reference: string',
  '  legacyReferences: readonly string[]',
  '}',
  '',
]
let count = 0
let bytes = 0
for (const [kind, pool] of Object.entries(BUILTIN_AVATARS)) {
  const ids = new Set()
  const avatars = pool.map((avatar) => {
    if (avatar.kind !== kind || ids.has(avatar.id)) throw new Error(`头像分类或 ID 无效：${kind}/${avatar.id}`)
    ids.add(avatar.id)
    const png = new Resvg(avatar.svg, { fitTo: { mode: 'width', value: 512 }, font: { loadSystemFonts: false } }).render().asPng()
    const reference = referenceOf(png)
    const old = previous[kind]?.find(({ id }) => id === avatar.id)
    // 留住历史内容引用；以后改同一张 SVG 时，旧快照仍能恢复到同名头像，而不是随机换脸。
    const legacyReferences = [...new Set([
      ...(old?.legacyReferences ?? []),
      ...(old ? [old.reference] : []),
      referenceOf(Buffer.from(avatar.svg)),
    ])].filter((value) => value !== reference)
    count++
    bytes += png.length
    return { id: avatar.id, kind, png: png.toString('base64'), reference, legacyReferences }
  })
  lines.push(`export const BUILTIN_${kind.toUpperCase()}_AVATARS: readonly BuiltinAvatar[] = ${JSON.stringify(avatars, null, 2)}`, '')
}
lines.push(
  'export const BUILTIN_AVATARS: Readonly<Record<BuiltinAvatarKind, readonly BuiltinAvatar[]>> = {',
  '  user: BUILTIN_USER_AVATARS,',
  '  bot: BUILTIN_BOT_AVATARS,',
  '  group: BUILTIN_GROUP_AVATARS,',
  '}',
  '',
)
const content = lines.join('\n')
if (process.argv.includes('--check')) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== content) {
    console.error('[avatars] PNG 产物已过期，运行 node scripts/generate-builtin-avatars.mjs 重新生成')
    process.exitCode = 1
  } else {
    console.log(`[avatars] ${count} 张 512×512 PNG 与 SVG 源一致`)
  }
} else {
  writeFileSync(output, content)
  console.log(`[avatars] 生成 ${count} 张 512×512 PNG，共 ${bytes} 字节 → ${output}`)
}
