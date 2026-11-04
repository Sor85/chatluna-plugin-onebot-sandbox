import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type { SandboxMedia, SandboxMediaContent, SandboxMediaType } from './types'
import { SandboxDomainError } from './types'

export const MAX_MEDIA_SIZE = 10 * 1024 * 1024

/** 同时钉住的在途上传数量上限；超出后最旧的钉住项被释放，重新变成可回收孤儿。 */
export const MAX_PINNED_MEDIA = 256

/** 只保留 SandboxMedia 契约字段，剥掉调用方挂在同一对象上的 dataBase64 等附加属性。 */
export function toMediaMetadata(media: SandboxMedia): SandboxMedia {
  return {
    id: media.id,
    type: media.type,
    name: media.name,
    mimeType: media.mimeType,
    size: media.size,
    reference: media.reference,
  }
}

const MEDIA_TYPES = new Map<string, SandboxMediaType>([
  ['image/gif', 'image'],
  ['image/jpeg', 'image'],
  ['image/png', 'image'],
  ['image/svg+xml', 'image'],
  ['image/webp', 'image'],
  ['audio/aac', 'audio'],
  ['audio/m4a', 'audio'],
  ['audio/mpeg', 'audio'],
  ['audio/mp4', 'audio'],
  ['audio/ogg', 'audio'],
  ['audio/wav', 'audio'],
  ['audio/webm', 'audio'],
  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
  ['video/webm', 'video'],
  ['application/json', 'file'],
  ['application/msword', 'file'],
  ['application/pdf', 'file'],
  ['application/vnd.ms-excel', 'file'],
  ['application/vnd.ms-powerpoint', 'file'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'file'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file'],
  ['application/zip', 'file'],
  ['text/csv', 'file'],
  ['text/plain', 'file'],
])

export class SandboxMediaStorage {
  // 已落盘但尚未进入场景的媒体。MCP 的 upload_media → send_message 是两步契约，
  // 两步之间的任何一次场景变更都会触发 reclaimUnreferenced；没有这个集合时刚上传的
  // 正文会被当成孤儿删掉，随后 send_message 读取正文必然抛「媒体文件不存在」。
  // 只存在于进程内：钉住状态保护的是本次进程里在途的上传，不需要跨重启恢复。
  // 按插入顺序限量，避免"上传后从不发送"的调用把孤儿正文永久钉在磁盘上。
  private pinned = new Set<string>()

  constructor(private directory: string, private maxPinned = MAX_PINNED_MEDIA) {
    mkdirSync(directory, { recursive: true })
  }

  clear(): void {
    this.pinned.clear()
    rmSync(this.directory, { recursive: true, force: true })
    mkdirSync(this.directory, { recursive: true })
  }

  /** 删除整个媒体目录且不重建，供实例级临时目录在 dispose 时回收。 */
  destroy(): void {
    this.pinned.clear()
    rmSync(this.directory, { recursive: true, force: true })
  }

  pin(id: string): void {
    this.assertId(id)
    // 重新钉住时先删后加，让 Set 的插入顺序反映最近使用，淘汰的总是最旧的在途上传。
    this.pinned.delete(id)
    this.pinned.add(id)
    while (this.pinned.size > this.maxPinned) {
      const oldest = this.pinned.values().next()
      if (oldest.done) break
      this.pinned.delete(oldest.value)
    }
  }

  unpin(id: string): void {
    this.pinned.delete(id)
  }

  isPinned(id: string): boolean {
    return this.pinned.has(id)
  }

  save(input: { fileName: string; mimeType: string; dataBase64: string }): SandboxMedia {
    const mimeType = input.mimeType.trim().toLowerCase()
    const type = MEDIA_TYPES.get(mimeType)
    if (!type) throw new SandboxDomainError(`不支持的媒体类型：${input.mimeType || '未知'}`)
    const name = basename(input.fileName.replaceAll('\\', '/')).trim()
    if (!name) throw new SandboxDomainError('媒体文件名不能为空')
    // 先按 Base64 理论长度拒绝超限输入，避免巨型字符串进入正则后耗尽调用栈或 CPU。
    const dataBase64 = input.dataBase64.trim()
    const paddingSize = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0
    if (Math.floor(dataBase64.length * 3 / 4) - paddingSize > MAX_MEDIA_SIZE) {
      throw new SandboxDomainError('媒体大小不能超过 10 MB')
    }
    if (!dataBase64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) {
      throw new SandboxDomainError('媒体内容不是有效的 Base64')
    }
    const content = Buffer.from(dataBase64, 'base64')
    if (!content.length) throw new SandboxDomainError('媒体内容不能为空')
    if (content.length > MAX_MEDIA_SIZE) throw new SandboxDomainError('媒体大小不能超过 10 MB')

    // 内容寻址：相同正文复用同一媒体 ID，便于头像去重与引用感知回收。
    const id = createHash('sha256').update(content).digest('hex').slice(0, 32)
    const media: SandboxMedia = {
      id,
      type,
      name,
      mimeType,
      size: content.length,
      reference: `sandbox-media://${id}`,
    }
    if (this.exists(id)) {
      // 去重命中时只返回元数据，避免把正文 base64 泄漏进场景快照。
      const { dataBase64: _ignored, ...existing } = this.readById(id)
      return existing
    }
    try {
      writeFileSync(this.getPath(id), content, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    try {
      writeFileSync(this.getMetadataPath(id), `${JSON.stringify(media)}\n`, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (this.exists(id)) {
      const { dataBase64: _ignored, ...existing } = this.readById(id)
      return existing
    }
    return media
  }

  read(media: SandboxMedia): SandboxMediaContent {
    this.validateReference(media)
    try {
      return {
        ...media,
        dataBase64: readFileSync(this.getPath(media.id)).toString('base64'),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SandboxDomainError(`媒体文件不存在：${media.id}`)
      throw error
    }
  }

  readById(id: string): SandboxMediaContent {
    let media: SandboxMedia
    try {
      media = JSON.parse(readFileSync(this.getMetadataPath(id), 'utf8')) as SandboxMedia
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SandboxDomainError(`媒体文件不存在：${id}`)
      throw error
    }
    return this.read(media)
  }

  exists(id: string): boolean {
    return existsSync(this.getPath(id)) && existsSync(this.getMetadataPath(id))
  }

  reclaimUnreferenced(references: ReadonlySet<string>): void {
    // 进入场景引用集就不再是"在途上传"，释放钉住，让它回到正常的引用感知回收。
    for (const id of [...this.pinned]) {
      if (references.has(`sandbox-media://${id}`)) this.pinned.delete(id)
    }
    if (!existsSync(this.directory)) return
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      // 只回收媒体正文与 sidecar，跳过目录与其他附属文件。
      if (!entry.isFile()) continue
      if (!/^[a-f0-9]{32}(?:\.meta\.json)?$/.test(entry.name)) continue
      const id = entry.name.endsWith('.meta.json') ? entry.name.slice(0, 32) : entry.name
      if (references.has(`sandbox-media://${id}`)) continue
      // 钉住的媒体已落盘但还没被任何场景引用，属于在途上传，不是孤儿。
      if (this.pinned.has(id)) continue
      rmSync(this.getPath(id), { force: true })
      rmSync(this.getMetadataPath(id), { force: true })
    }
  }

  remove(media: SandboxMedia): void {
    this.validateReference(media)
    this.pinned.delete(media.id)
    try {
      unlinkSync(this.getPath(media.id))
      rmSync(this.getMetadataPath(media.id), { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private assertId(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new SandboxDomainError(`无效媒体标识：${id}`)
    return id
  }

  private getPath(id: string): string {
    return resolve(this.directory, this.assertId(id))
  }

  private getMetadataPath(id: string): string {
    return `${this.getPath(id)}.meta.json`
  }

  private validateReference(media: SandboxMedia): void {
    if (media.reference !== `sandbox-media://${media.id}`) throw new SandboxDomainError(`无效媒体引用：${media.id}`)
  }
}
