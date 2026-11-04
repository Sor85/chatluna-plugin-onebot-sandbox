import { randomBytes } from 'node:crypto'

/** 十六进制随机标识；沙盒消息 ID 依赖十六进制形态换算 OneBot 数字消息 ID。 */
export const Random = {
  id(length = 8): string {
    return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
  },
}
