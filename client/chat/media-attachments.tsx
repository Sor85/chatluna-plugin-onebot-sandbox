import * as React from 'react'
import {
  DownloadIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileMusicIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoCameraIcon,
  PauseIcon,
  PlayIcon,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@chatluna/ui-kit'
import type { SandboxMedia } from '../../src/types'
import { useT } from '../i18n'
import { formatMediaSize } from '../webqq/message-presentation'
import {
  computeWaveformPeaks,
  fallbackWaveformPeaks,
  formatPlaybackTime,
  getFileExtension,
  getFileKind,
  type FileKind,
} from '../webqq/media-attachment'

interface Waveform {
  peaks: number[]
  duration: number
}

/** 超过这个体积不在浏览器里解码波形，改用按 ID 生成的形状，免得长音频占住主线程。 */
const WAVEFORM_DECODE_LIMIT = 16 * 1024 * 1024
/** 解码结果按媒体 ID 缓存：媒体 ID 是内容哈希，切换会话再回来不重新解码。 */
const waveforms = new Map<string, Promise<Waveform | undefined>>()

function loadWaveform(media: SandboxMedia, source: string) {
  let task = waveforms.get(media.id)
  if (!task) {
    task = media.size > WAVEFORM_DECODE_LIMIT ? Promise.resolve(undefined) : decodeWaveform(source).catch(() => undefined)
    waveforms.set(media.id, task)
  }
  return task
}

async function decodeWaveform(source: string): Promise<Waveform> {
  const data = await (await fetch(source)).arrayBuffer()
  // 只需要包络：解码到 8 kHz 单声道，Firefox 支持的最低采样率，内存占用最小。
  const buffer = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(data)
  return { peaks: computeWaveformPeaks(buffer.getChannelData(0)), duration: buffer.duration }
}

/** 同一时刻只播一条语音，开始播放时停掉上一条。 */
let activeAudio: HTMLAudioElement | undefined

export function VoiceMessage(props: { media: SandboxMedia; source?: string; failed?: boolean; disabled?: boolean }) {
  const t = useT()
  const { media, source } = props
  const audio = React.useRef<HTMLAudioElement>(null)
  const [peaks, setPeaks] = React.useState(() => fallbackWaveformPeaks(media.id))
  const [duration, setDuration] = React.useState(Number.NaN)
  const [current, setCurrent] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)

  React.useEffect(() => {
    if (!source) return
    let alive = true
    void loadWaveform(media, source).then((waveform) => {
      if (!alive || !waveform) return
      setPeaks(waveform.peaks)
      setDuration((value) => Number.isFinite(value) ? value : waveform.duration)
    })
    return () => {
      alive = false
    }
  }, [media, source])

  // timeupdate 每秒只派发几次，播放中按帧读进度，波形填色才连贯。
  React.useEffect(() => {
    if (!playing) return
    let frame = requestAnimationFrame(function tick() {
      if (audio.current) setCurrent(audio.current.currentTime)
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [playing])

  React.useEffect(() => {
    const element = audio.current
    return () => {
      element?.pause()
      if (activeAudio === element) activeAudio = undefined
    }
  }, [source])

  const ready = !!source && !props.disabled
  const progress = Number.isFinite(duration) && duration > 0 ? Math.min(1, current / duration) : 0

  const toggle = () => {
    const element = audio.current
    if (!element || !source) return
    if (!element.paused) {
      element.pause()
      return
    }
    if (activeAudio && activeAudio !== element) activeAudio.pause()
    activeAudio = element
    void element.play().catch(() => setPlaying(false))
  }

  const seek = (seconds: number) => {
    const element = audio.current
    if (!element || !Number.isFinite(duration)) return
    const value = Math.max(0, Math.min(duration, seconds))
    element.currentTime = value
    setCurrent(value)
  }

  const seekToPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    seek((event.clientX - rect.left) / rect.width * duration)
  }

  const status = props.failed ? t('sandbox.media.unavailable') : !source ? t('sandbox.media.loading') : undefined
  const bars = peaks.map((peak, index) => <span key={index} style={{ height: `${Math.round(peak * 100)}%` }} />)

  return (
    <div className={cn('sandbox-message-voice', playing && 'is-playing')}>
      {source && (
        <audio
          ref={audio}
          src={source}
          preload="metadata"
          onLoadedMetadata={(event) => {
            const value = event.currentTarget.duration
            if (Number.isFinite(value)) setDuration(value)
          }}
          onPlay={() => setPlaying(true)}
          onPause={(event) => {
            setPlaying(false)
            setCurrent(event.currentTarget.currentTime)
          }}
          onEnded={(event) => {
            event.currentTarget.currentTime = 0
            setCurrent(0)
          }}
        />
      )}
      <button
        type="button"
        className="sandbox-message-voice-toggle"
        disabled={!ready}
        aria-label={playing ? t('sandbox.media.pauseVoice') : t('sandbox.media.playVoice')}
        onClick={(event) => {
          event.stopPropagation()
          toggle()
        }}
      >
        {playing ? <PauseIcon className="size-3.5" fill="currentColor" /> : <PlayIcon className="size-3.5 translate-x-px" fill="currentColor" />}
      </button>
      <div
        className="sandbox-message-voice-wave"
        role="slider"
        tabIndex={ready ? 0 : -1}
        aria-label={t('sandbox.media.voiceProgress')}
        aria-disabled={!ready}
        aria-valuemin={0}
        aria-valuemax={Number.isFinite(duration) ? Math.round(duration) : 0}
        aria-valuenow={Math.round(current)}
        aria-valuetext={`${formatPlaybackTime(current)} / ${formatPlaybackTime(duration)}`}
        onPointerDown={(event) => {
          if (!ready || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          seekToPointer(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) seekToPointer(event)
        }}
        onKeyDown={(event) => {
          if (!ready) return
          const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[event.key]
          if (step !== undefined) seek(current + step)
          else if (event.key === 'Home') seek(0)
          else if (event.key === 'End') seek(duration)
          else return
          event.preventDefault()
        }}
      >
        <span className="sandbox-message-voice-bars" aria-hidden>{bars}</span>
        {/* 已播放的部分是同一组竖条的填色副本，按进度裁剪，播放中逐帧推进而不是逐根跳变。 */}
        <span className="sandbox-message-voice-bars is-played" aria-hidden style={{ clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)` }}>{bars}</span>
      </div>
      <span className="sandbox-message-voice-time">
        {status ?? formatPlaybackTime(playing || current > 0 ? current : duration)}
      </span>
    </div>
  )
}

const FILE_ICONS: Record<FileKind, LucideIcon> = {
  archive: FileArchiveIcon,
  audio: FileMusicIcon,
  code: FileCodeIcon,
  document: FileTextIcon,
  image: FileImageIcon,
  sheet: FileSpreadsheetIcon,
  video: FileVideoCameraIcon,
  other: FileIcon,
}

export function FileMessage(props: { media: SandboxMedia; source?: string; failed?: boolean }) {
  const t = useT()
  const { media, source } = props
  const kind = getFileKind(media.name, media.mimeType)
  const Icon = FILE_ICONS[kind]
  const extension = getFileExtension(media.name).toUpperCase()
  const meta = props.failed ? t('sandbox.media.unavailable') : !source ? t('sandbox.media.loading') : [formatMediaSize(media.size), extension].filter(Boolean).join(' · ')
  const content = (
    <>
      <span className="sandbox-message-file-icon" data-kind={kind}><Icon className="size-5" /></span>
      <span className="sandbox-message-file-info">
        <strong title={media.name}>{media.name}</strong>
        <small>{meta}</small>
      </span>
      {source && <span className="sandbox-message-file-download" aria-hidden><DownloadIcon className="size-4" /></span>}
    </>
  )
  // 媒体未就绪时先占好卡片位置，读到内容后原位变成下载链接，不出现「加载中」一行再撑开。
  return source ? (
    <a href={source} download={media.name} className="sandbox-message-file" aria-label={t('sandbox.media.downloadFile', { name: media.name })}>{content}</a>
  ) : (
    <div className="sandbox-message-file is-pending">{content}</div>
  )
}
