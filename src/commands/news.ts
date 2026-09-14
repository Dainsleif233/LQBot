// /news —— 开关当前场景（群聊或私聊）的新闻推送订阅，语义与 /games subscribe 一致。
// 等级 2（全局管理员）：外部新闻源 POST /news 时，向订阅过的群/私聊推送 Markdown。
// 订阅状态只看 news 命名空间的订阅者索引（news:global:subs）：有本场景条目 = 已订阅。
import { defineCommand } from '../lib/define.js';
import { LEVELS } from '../lib/permissions.js';
import { toggleSubscription } from './libs/news.js';
import type { CommandContext, Scene } from '../lib/types.js';

export default defineCommand({
  name: 'news',
  description: '开关新闻推送订阅',
  scenes: ['group', 'private'],
  minLevel: LEVELS.GLOBAL_ADMIN, // 2
  async handler(ctx: CommandContext): Promise<void> {
    if (!ctx.cfg.storage.available) {
      await ctx.reply('KV 未绑定，新闻订阅不可用。');
      return;
    }
    const scene: Scene = ctx.scene;
    const openid = (scene === 'group' ? ctx.groupOpenid : ctx.userOpenid) || '';
    if (!openid) {
      await ctx.reply('无法确定当前场景（缺少 openid），无法订阅。');
      return;
    }
    const on = await toggleSubscription(ctx.cfg, scene, openid);
    const where = scene === 'group' ? '本群' : '本会话';
    await ctx.reply(on
      ? '✓ 已开启' + where + '的新闻推送订阅（有新闻时收到 Markdown 推送）。'
      : '✓ 已关闭' + where + '的新闻推送订阅。');
  },
});
