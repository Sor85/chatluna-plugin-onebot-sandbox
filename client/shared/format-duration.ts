export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  if (durationMs < 60_000) {
    const seconds = durationMs / 1000
    return `${formatDurationNumber(seconds, seconds < 10 ? 2 : 1)} s`
  }

  const totalSeconds = Math.round(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours) parts.push(`${hours} h`)
  if (minutes) parts.push(`${minutes} min`)
  if (seconds || !parts.length) parts.push(`${seconds} s`)
  return parts.join(' ')
}

function formatDurationNumber(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)))
}
