import type { Context } from 'cordis'
import zh from './locales/zh.yml'
import en from './locales/en.yml'

export default function apply(ctx: Context) {
  ctx.locale.register('onebot-sandbox', { zh, en })
  ctx.slots.route({
    path: '/onebot-sandbox/:view?',
    page: async () => (await import('./app')).SandboxApp,
    title: 'OneBot 沙盒',
    icon: 'flask-conical',
    order: 60,
    group: 'chat',
    groupOrder: 20,
  })
}
