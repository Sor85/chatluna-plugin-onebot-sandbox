import { assertMediaSize } from './media-limits'
import { SandboxDomainError } from './types'

/** 头像与机器人媒体共用流式限额；不能只信 Content-Length，也不能先读完整正文再拒绝。 */
export async function readMediaResponse(response: Response, limit: number, kind = '媒体'): Promise<Buffer> {
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > limit) {
    await response.body?.cancel().catch(() => {})
    assertMediaSize(declaredSize, limit, kind)
  }
  if (!response.body) throw new SandboxDomainError(`${kind}内容不能为空`)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        assertMediaSize(size, limit, kind)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  if (!size) throw new SandboxDomainError(`${kind}内容不能为空`)
  return Buffer.concat(chunks, size)
}
