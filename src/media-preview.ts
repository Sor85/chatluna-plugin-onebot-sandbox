import { isVoiceIn, voiceForModel } from '@chatluna/transform'
import { SandboxDomainError, type SandboxMediaContent } from './types'

/** SILK 原件仍用于协议与导出，浏览器只消费单独的 WAV 预览。 */
export async function withAudioPreview(content: SandboxMediaContent): Promise<SandboxMediaContent> {
  if (content.type !== 'audio') return content
  const buffer = Buffer.from(content.dataBase64, 'base64')
  if (!isVoiceIn('silk', buffer, content.mimeType)) {
    if (content.mimeType === 'audio/silk' || content.mimeType === 'audio/x-silk') {
      throw new SandboxDomainError('SILK 语音内容无效')
    }
    return content
  }
  try {
    const wav = await voiceForModel(buffer)
    return { ...content, preview: { mimeType: 'audio/wav', dataBase64: wav.toString('base64') } }
  } catch (error) {
    throw new SandboxDomainError(`SILK 语音预览转换失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
