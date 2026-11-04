export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${formatBytesNumber(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${formatBytesNumber(bytes / (1024 * 1024))} MB`
  return `${formatBytesNumber(bytes / (1024 * 1024 * 1024))} GB`
}

function formatBytesNumber(value: number): string {
  return String(Number(value.toFixed(value < 10 ? 1 : 0)))
}
