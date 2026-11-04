import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // ChatLuna v2 以 `koishi` 名义提供 Cordis 4 版 @koishijs/core；测试沿用 Koishi App 作为宿主。
    alias: { '@koishijs/core': 'koishi' },
  },
  test: {
    include: ['tests/*.test.ts'],
  },
})
