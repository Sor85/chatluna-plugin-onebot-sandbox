export interface WorkspaceThumbnailTransform {
  scale: number
  left: number
  top: number
}

export function calculateContainedWorkspaceThumbnailTransform(input: {
  containerWidth: number
  containerHeight: number
  canvasWidth: number
  canvasHeight: number
}): WorkspaceThumbnailTransform | undefined {
  const { containerWidth, containerHeight, canvasWidth, canvasHeight } = input
  if (!containerWidth || !containerHeight || !canvasWidth || !canvasHeight) return
  const scale = Math.min(containerWidth / canvasWidth, containerHeight / canvasHeight)
  return {
    scale,
    left: (containerWidth - canvasWidth * scale) / 2,
    top: (containerHeight - canvasHeight * scale) / 2,
  }
}
