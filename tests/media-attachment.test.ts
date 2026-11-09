import { describe, expect, it } from 'vitest'
import {
  computeWaveformPeaks,
  fallbackWaveformPeaks,
  formatPlaybackTime,
  getFileExtension,
  getFileKind,
  WAVEFORM_BARS,
} from '../client/webqq/media-attachment'

describe('文件卡片归类', () => {
  it('扩展名优先于 MIME，认不出时退回 MIME 主类型', () => {
    expect(getFileKind('abgrund_さいかわゆさ.MP3', 'application/octet-stream')).toBe('audio')
    expect(getFileKind('report.pdf', 'application/pdf')).toBe('document')
    expect(getFileKind('archive.tar.gz', 'application/gzip')).toBe('archive')
    expect(getFileKind('clip', 'video/mp4')).toBe('video')
    expect(getFileKind('notes', 'text/plain')).toBe('document')
    expect(getFileKind('blob', 'application/octet-stream')).toBe('other')
  })

  it('隐藏文件名与异常尾段不算扩展名', () => {
    expect(getFileExtension('.env')).toBe('')
    expect(getFileExtension('name.')).toBe('')
    expect(getFileExtension('v1.2 final draft')).toBe('')
    expect(getFileExtension('Song.FLAC')).toBe('flac')
  })
})

describe('语音波形', () => {
  it('按段取均方根并归一化，静音段保留最低高度', () => {
    const samples = new Float32Array(WAVEFORM_BARS * 10)
    samples.fill(0.5, 0, 10)
    const peaks = computeWaveformPeaks(samples)
    expect(peaks).toHaveLength(WAVEFORM_BARS)
    expect(peaks[0]).toBe(1)
    expect(Math.min(...peaks)).toBeGreaterThan(0)
    expect(peaks.slice(1).every((peak) => peak === peaks[1])).toBe(true)
  })

  it('整段静音或样本过少时仍给出完整竖条', () => {
    expect(computeWaveformPeaks(new Float32Array(WAVEFORM_BARS * 4))).toHaveLength(WAVEFORM_BARS)
    expect(computeWaveformPeaks(new Float32Array(3))).toHaveLength(WAVEFORM_BARS)
  })

  it('兜底波形按媒体 ID 稳定且落在可见范围内', () => {
    const peaks = fallbackWaveformPeaks('media-1')
    expect(fallbackWaveformPeaks('media-1')).toEqual(peaks)
    expect(fallbackWaveformPeaks('media-2')).not.toEqual(peaks)
    expect(peaks.every((peak) => peak > 0 && peak <= 1)).toBe(true)
  })

  it('时长显示为 m:ss，未知时显示占位', () => {
    expect(formatPlaybackTime(0)).toBe('0:00')
    expect(formatPlaybackTime(30.9)).toBe('0:30')
    expect(formatPlaybackTime(605)).toBe('10:05')
    expect(formatPlaybackTime(Number.NaN)).toBe('-:--')
    expect(formatPlaybackTime(Infinity)).toBe('-:--')
  })
})
