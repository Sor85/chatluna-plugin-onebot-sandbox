import { SandboxDomainError } from './types'

export const MEBIBYTE = 1024 * 1024
export const DEFAULT_MEDIA_MAX_SIZE = 10 * MEBIBYTE

export function assertMediaSize(size: number, limit: number, kind = '媒体'): void {
  if (size > limit) throw new SandboxDomainError(`${kind}大小不能超过 ${limit / MEBIBYTE} MiB`)
}

/** 保留原有 32 MiB 请求预算；上调文件限额时容纳完整 Base64，另留 1 MiB 给 JSON 信封。 */
export function mediaRequestBodyLimit(mediaMaxSize: number): number {
  return Math.max(32 * MEBIBYTE, 4 * Math.ceil(mediaMaxSize / 3) + MEBIBYTE)
}
