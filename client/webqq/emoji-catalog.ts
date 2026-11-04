import { readStored, writeStored } from '@chatluna/ui-storage'
import * as qface from 'qface'

export interface SandboxEmojiFace {
  id: string
  label: string
  url: string
  inputs: string[]
}

// TIM/QQ 常用回应优先展示这些 QSid；缺失时再回退到 qface 的 isCMEmoji。
const preferredCommonIds = ['76', '66', '63', '64', '39', '116', '59', '98', '2', '178', '179', '182']

function toFace(item: qface.Face): SandboxEmojiFace {
  return {
    id: item.QSid,
    label: item.QDes.replace(/^\//, '') || item.QSid,
    url: qface.getUrl(item.QSid),
    inputs: item.Input ?? [],
  }
}

export function listSandboxEmojiFaces(): SandboxEmojiFace[] {
  return qface.data
    .filter((item) => !item.QHide)
    .map(toFace)
}

export function getSandboxEmojiFace(emojiId: string): SandboxEmojiFace | undefined {
  const face = qface.get(emojiId)
  if (face) return toFace(face)
  // OneBot 有时上报 Unicode codepoint 数字（如 128077）；找不到 qface 条目时用原值兜底展示。
  const id = emojiId.trim()
  if (!id) return undefined
  return {
    id,
    label: /^\d+$/.test(id) ? '[表情]' : id,
    url: '',
    inputs: [],
  }
}

export function getCommonSandboxEmojiFaces(): SandboxEmojiFace[] {
  const byId = new Map(listSandboxEmojiFaces().map((face) => [face.id, face]))
  const preferred = preferredCommonIds.flatMap((id) => {
    const face = byId.get(id)
    return face ? [face] : []
  })
  if (preferred.length) return preferred
  return listSandboxEmojiFaces().filter((face) => qface.get(face.id)?.isCMEmoji).slice(0, 24)
}

export function searchSandboxEmojiFaces(query: string): SandboxEmojiFace[] {
  const keyword = query.trim().toLowerCase()
  const faces = listSandboxEmojiFaces()
  if (!keyword) return faces
  return faces.filter((face) => {
    if (face.id.includes(keyword)) return true
    if (face.label.toLowerCase().includes(keyword)) return true
    return face.inputs.some((input) => input.toLowerCase().includes(keyword))
  })
}

const recentStorageKey = 'chatluna.onebot-sandbox.recent-emoji-ids'

export function loadRecentSandboxEmojiIds(): string[] {
  const stored = readStored(recentStorageKey)
  if (!Array.isArray(stored)) return []
  return stored.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 24)
}

export function rememberSandboxEmojiId(emojiId: string): string[] {
  const id = emojiId.trim()
  if (!id) return loadRecentSandboxEmojiIds()
  const next = [id, ...loadRecentSandboxEmojiIds().filter((item) => item !== id)].slice(0, 24)
  writeStored(recentStorageKey, next)
  return next
}
