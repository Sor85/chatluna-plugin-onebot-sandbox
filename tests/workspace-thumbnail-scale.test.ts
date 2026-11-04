import { describe, expect, it } from 'vitest'
import { calculateContainedWorkspaceThumbnailTransform } from '../client/test-space/thumbnail-scale'

describe('工作区缩略图缩放', () => {
  it('宽卡片按高度受限并完整保留页面宽度', () => {
    expect(calculateContainedWorkspaceThumbnailTransform({
      containerWidth: 600,
      containerHeight: 190,
      canvasWidth: 1440,
      canvasHeight: 760,
    })).toEqual({
      scale: 0.25,
      left: 120,
      top: 0,
    })
  })

  it('窄卡片按宽度受限并垂直居中完整页面', () => {
    expect(calculateContainedWorkspaceThumbnailTransform({
      containerWidth: 300,
      containerHeight: 190,
      canvasWidth: 1440,
      canvasHeight: 760,
    })).toEqual({
      scale: 300 / 1440,
      left: 0,
      top: (190 - 760 * (300 / 1440)) / 2,
    })
  })

  it('画布或容器无尺寸时不生成无效变换', () => {
    expect(calculateContainedWorkspaceThumbnailTransform({
      containerWidth: 0,
      containerHeight: 190,
      canvasWidth: 1440,
      canvasHeight: 760,
    })).toBeUndefined()
  })
})
