import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode } from 'silk-wasm'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxMediaStorage } from '../src/media-storage'
import { withAudioPreview } from '../src/media-preview'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

async function fixture(mimeType = 'audio/silk') {
  const directory = await mkdtemp(join(tmpdir(), 'sandbox-silk-'))
  directories.push(directory)
  const storage = new SandboxMediaStorage(directory)
  const pcm = Buffer.alloc(2400 * 2)
  for (let index = 0; index < 2400; index++) pcm.writeInt16LE(Math.round(1200 * Math.sin(index * Math.PI / 24)), index * 2)
  const { data } = await encode(pcm, 24000)
  const input = { fileName: 'voice.silk', mimeType, dataBase64: Buffer.from(data).toString('base64') }
  const media = storage.save(input)
  return { storage, media, input }
}

describe('SILK 媒体与浏览器预览', () => {
  it.each(['audio/silk', 'audio/x-silk', 'audio/mpeg'])('识别 %s 中的 SILK，保留原始字节和内容 ID', async (mimeType) => {
    const { storage, media, input } = await fixture(mimeType)
    expect(media.type).toBe('audio')
    expect(media.mimeType).toBe('audio/silk')
    expect(storage.read(media).dataBase64).toBe(input.dataBase64)
    expect(storage.save({ ...input, mimeType: 'audio/silk' }).id).toBe(media.id)
  })

  it('只在响应中增加 16 kHz 单声道 WAV，不修改原始媒体', async () => {
    const { storage, media, input } = await fixture()
    const original = storage.read(media)
    const response = await withAudioPreview(original)
    expect(response.dataBase64).toBe(input.dataBase64)
    expect(response.id).toBe(media.id)
    expect(response.mimeType).toBe('audio/silk')
    expect(response.preview?.mimeType).toBe('audio/wav')
    const wav = Buffer.from(response.preview!.dataBase64, 'base64')
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 12).toString()).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.length).toBeGreaterThan(44)
    expect(storage.read(media)).toEqual(original)
    expect(original).not.toHaveProperty('preview')
  })

  it('普通音频和非音频不产生派生预览', async () => {
    const { storage } = await fixture()
    for (const mimeType of ['audio/mpeg', 'audio/wav', 'image/png']) {
      const media = storage.save({ fileName: 'original', mimeType, dataBase64: Buffer.from(mimeType).toString('base64') })
      const content = storage.read(media)
      expect(await withAudioPreview(content)).toBe(content)
    }
  })

  it('损坏的 SILK 明确报错，不返回伪 WAV', async () => {
    const { storage } = await fixture()
    const media = storage.save({ fileName: 'broken.silk', mimeType: 'audio/silk', dataBase64: Buffer.from('broken').toString('base64') })
    await expect(withAudioPreview(storage.read(media))).rejects.toThrow('SILK 语音内容无效')
  })
})
