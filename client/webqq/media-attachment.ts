/** 语音条与文件卡片的纯逻辑：文件归类、波形采样与时长格式。 */

export type FileKind = 'archive' | 'audio' | 'code' | 'document' | 'image' | 'sheet' | 'video' | 'other'

const EXTENSION_KINDS: Record<string, FileKind> = {
  '7z': 'archive', bz2: 'archive', gz: 'archive', rar: 'archive', tar: 'archive', tgz: 'archive', xz: 'archive', zip: 'archive', zst: 'archive',
  aac: 'audio', amr: 'audio', flac: 'audio', m4a: 'audio', mp3: 'audio', ogg: 'audio', opus: 'audio', silk: 'audio', wav: 'audio', wma: 'audio',
  avi: 'video', flv: 'video', m4v: 'video', mkv: 'video', mov: 'video', mp4: 'video', webm: 'video', wmv: 'video',
  avif: 'image', bmp: 'image', gif: 'image', heic: 'image', ico: 'image', jpeg: 'image', jpg: 'image', png: 'image', svg: 'image', webp: 'image',
  csv: 'sheet', numbers: 'sheet', ods: 'sheet', tsv: 'sheet', xls: 'sheet', xlsx: 'sheet',
  doc: 'document', docx: 'document', epub: 'document', key: 'document', md: 'document', odt: 'document', pages: 'document', pdf: 'document',
  ppt: 'document', pptx: 'document', rtf: 'document', txt: 'document',
  c: 'code', cpp: 'code', css: 'code', go: 'code', h: 'code', html: 'code', java: 'code', js: 'code', json: 'code', jsx: 'code', kt: 'code',
  mjs: 'code', php: 'code', py: 'code', rb: 'code', rs: 'code', sh: 'code', sql: 'code', ts: 'code', tsx: 'code', xml: 'code', yaml: 'code', yml: 'code',
}

/** 不含点的小写扩展名；没有扩展名、以点开头的隐藏文件名或过长的尾段返回空串。 */
export function getFileExtension(name: string): string {
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  const extension = name.slice(index + 1).toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : ''
}

/** 扩展名优先，认不出时退回 MIME 主类型；`application/octet-stream` 之类归为 other。 */
export function getFileKind(name: string, mimeType: string): FileKind {
  const byExtension = EXTENSION_KINDS[getFileExtension(name)]
  if (byExtension) return byExtension
  const major = mimeType.split('/')[0]
  if (major === 'audio' || major === 'video' || major === 'image') return major
  if (major === 'text') return 'document'
  return 'other'
}

export const WAVEFORM_BARS = 32
/** 静音段也保留一截竖条，语音条不会出现空洞。 */
const MIN_BAR = 0.16

/** 按段取均方根并归一化到 [MIN_BAR, 1]。 */
export function computeWaveformPeaks(samples: ArrayLike<number>, bars = WAVEFORM_BARS): number[] {
  const size = Math.floor(samples.length / bars)
  if (size < 1) return fallbackWaveformPeaks('', bars)
  const levels: number[] = []
  for (let bar = 0; bar < bars; bar++) {
    let sum = 0
    for (let index = bar * size; index < (bar + 1) * size; index++) sum += samples[index]! * samples[index]!
    levels.push(Math.sqrt(sum / size))
  }
  const max = Math.max(...levels)
  if (!(max > 0)) return levels.map(() => MIN_BAR)
  return levels.map((level) => MIN_BAR + (1 - MIN_BAR) * (level / max))
}

/** 解码失败时按媒体 ID 生成稳定的起伏，同一条语音每次渲染形状一致。 */
export function fallbackWaveformPeaks(seed: string, bars = WAVEFORM_BARS): number[] {
  let state = 2166136261
  for (let index = 0; index < seed.length; index++) state = Math.imul(state ^ seed.charCodeAt(index), 16777619)
  return Array.from({ length: bars }, (_, bar) => {
    state = Math.imul(state ^ (state >>> 15), 2246822507) >>> 0
    const noise = (state % 1000) / 1000
    // 两端收窄、中段饱满，接近人声的包络。
    const envelope = Math.sin(Math.PI * (bar + 0.5) / bars)
    return MIN_BAR + (1 - MIN_BAR) * Math.min(1, 0.25 + 0.75 * envelope * (0.45 + 0.55 * noise))
  })
}

/** `m:ss`；时长未知时返回 `-:--`。 */
export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-:--'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
