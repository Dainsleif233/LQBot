// /server —— MC 服务器状态卡片（群聊 / 私聊）。
//
//   /server                       等级 0  当前会话（群聊按群 id、私聊按用户 id）已添加服务器的列表图片
//   /server <address>             等级 0  查询指定服务器，返回单服务器图片
//   /server add <address> [位置]   等级 1  为会话添加服务器（位置从 1 起，不给则加在最后）
//   /server del <address|位置>     等级 1  为会话删除服务器
//
// 数据存 KV（server 命名空间）的**场景变量**：群聊 server:group:<group_openid>:list，
// 私聊 server:user:<user_openid>:list —— 每个群 / 每个用户各一份列表，互不影响。
// 状态取自 api.jsumc.fun（批量 ping）；SVG 交给它的 /svg 渲染接口换成 PNG 地址后再发图（见 libs/jsumc.ts）。
import { LEVELS } from '../libs/permissions.js';
import { defineCommand } from '../libs/define.js';
import { pingServers, renderSvgToImageUrl, JSUMC_IMAGE_TYPE } from './libs/jsumc.js';
import { renderCard, renderList, snapshotTime, toServer } from './libs/mccard.js';
import type { SvgImage } from './libs/mccard.js';
import type { CommandContext, Store } from '../libs/types.js';

const NS = 'server';
/** 场景列表在 KV 里的 key（实际 key 形如 server:group:<gid>:list） */
const LIST_KEY = 'list';
/** 一次最多查询几台（渲染接口单次最多 20 台，分片请求；图片本身还会按画布高度上限再裁） */
const MAX_LIST = 24;
/** 地址：域名或 IP，可带端口（与 ping 接口的 server 参数一致） */
const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}(?::\d{1,5})?$/;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sceneLabel(ctx: CommandContext): string {
  return ctx.scene === 'group' ? '本群' : '本会话';
}

/** 场景存储（按群 / 按用户）；openid 缺失时为 null */
function sceneStore(ctx: CommandContext): Store | null {
  return ctx.cfg.storage.ns(NS).scene(ctx);
}

async function loadList(store: Store): Promise<string[]> {
  const raw = await store.getJSON<unknown>(LIST_KEY);
  return Array.isArray(raw) ? (raw.filter((x) => typeof x === 'string') as string[]) : [];
}

async function saveList(store: Store, list: string[]): Promise<void> {
  await store.setJSON(LIST_KEY, list);
}

/** 地址在列表里的下标（不区分大小写；域名本身大小写不敏感） */
function indexOf(list: string[], address: string): number {
  return list.findIndex((x) => x.toLowerCase() === address.toLowerCase());
}

/** 列表的文本形式（1 起编号），用于增删后的回执；超过 limit 条只列前面几条 */
function listText(list: string[], limit = 10): string {
  const lines = list.slice(0, limit).map((x, i) => i + 1 + '. ' + x);
  if (list.length > limit) lines.push('……（共 ' + list.length + ' 台）');
  return lines.join('\n');
}

function usage(ctx: CommandContext): string {
  const label = sceneLabel(ctx);
  return '用法：\n' +
    '• /server —— 查看' + label + '已添加的服务器（列表图片）\n' +
    '• /server <地址> —— 查询单台服务器（图片）\n' +
    '• /server add <地址> [位置] —— 添加服务器（等级 1，位置从 1 起，缺省加在最后）\n' +
    '• /server del <地址|位置> —— 删除服务器（等级 1）';
}

/** 渲染 SVG -> 图片 URL -> 发图（图片 URL 由渲染接口的 cacheKey 拼出） */
async function sendCardImage(ctx: CommandContext, image: SvgImage): Promise<void> {
  const url = await renderSvgToImageUrl(image.svg, image.width);
  await ctx.replyMedia(JSUMC_IMAGE_TYPE, url);
}

/** /server <地址>：查询单台，出一张卡片 */
async function queryOne(ctx: CommandContext, address: string): Promise<void> {
  let results;
  try {
    results = await pingServers([address]);
  } catch (e) {
    await ctx.reply('查询服务器状态失败：' + errText(e));
    return;
  }
  try {
    await sendCardImage(ctx, renderCard(toServer(address, results[0])));
  } catch (e) {
    await ctx.reply('服务器状态图片生成失败：' + errText(e));
  }
}

/** /server：把当前会话的列表画成一张图 */
async function showList(ctx: CommandContext, list: string[]): Promise<void> {
  const shown = list.slice(0, MAX_LIST);
  let results;
  try {
    results = await pingServers(shown);
  } catch (e) {
    await ctx.reply('获取服务器状态失败：' + errText(e));
    return;
  }
  const servers = shown.map((host, i) => toServer(host, results[i]));
  const image = renderList(servers, { stamp: snapshotTime(), total: list.length });
  try {
    await sendCardImage(ctx, image);
  } catch (e) {
    await ctx.reply('服务器列表图片生成失败：' + errText(e));
  }
}

export default defineCommand({
  name: 'server',
  description: 'MC服务器状态',
  minLevel: LEVELS.USER, // 主命令：查询，等级 0

  async handler(ctx: CommandContext): Promise<void> {
    const address = (ctx.args[0] || '').trim();
    // 带参数 = 查询指定服务器（不需要 KV）
    if (address) {
      await queryOne(ctx, address);
      return;
    }
    if (!ctx.cfg.storage.ns(NS).available) {
      await ctx.reply('KV 未绑定，服务器列表不可用。');
      return;
    }
    const store = sceneStore(ctx);
    if (!store) {
      await ctx.reply('无法确定当前会话（缺少 openid），服务器列表不可用。');
      return;
    }
    const list = await loadList(store);
    if (!list.length) {
      await ctx.reply(sceneLabel(ctx) + '还没有添加服务器。\n' + usage(ctx));
      return;
    }
    await showList(ctx, list);
  },

  subcommands: [
    {
      // /server add <地址> [位置]
      name: 'add',
      description: '添加服务器',
      minLevel: LEVELS.GROUP_ADMIN, // 1
      async handler(ctx: CommandContext): Promise<void> {
        if (!ctx.cfg.storage.ns(NS).available) {
          await ctx.reply('KV 未绑定，无法保存服务器列表。');
          return;
        }
        const store = sceneStore(ctx);
        if (!store) {
          await ctx.reply('无法确定当前会话（缺少 openid），无法保存服务器列表。');
          return;
        }
        const usageText = '用法：/server add <地址> [位置]\n例：/server add mc.jsumc.fun（加在最后）\n    /server add mc.jsumc.fun 1（插到第 1 位）';
        if (!ctx.args.length || ctx.args.length > 2) {
          await ctx.reply(usageText);
          return;
        }
        const address = (ctx.args[0] || '').trim();
        const posArg = (ctx.args[1] || '').trim();
        if (!ADDRESS_RE.test(address)) {
          await ctx.reply('地址格式不对：' + address + '\n应为域名或 IP（可带端口），如 mc.jsumc.fun / 1.2.3.4:25565。\n' + usageText);
          return;
        }
        const list = await loadList(store);
        const dup = indexOf(list, address);
        if (dup >= 0) {
          await ctx.reply('已在列表里（第 ' + (dup + 1) + ' 位）：' + list[dup]);
          return;
        }
        let pos = list.length + 1;
        if (posArg) {
          if (!/^\d+$/.test(posArg)) {
            await ctx.reply('位置要写正整数（1 = 插到最前面）。当前列表 ' + list.length + ' 台。');
            return;
          }
          pos = parseInt(posArg, 10);
          if (pos < 1 || pos > list.length + 1) {
            await ctx.reply('位置超出范围：当前列表 ' + list.length + ' 台，可填 1~' + (list.length + 1) + '（缺省加在最后）。');
            return;
          }
        }
        list.splice(pos - 1, 0, address);
        await saveList(store, list);
        // 顺带探测一次：地址写错的话立刻能看出来（探测失败也照样保存，服务器可能只是暂时没开）
        let probe = '';
        try {
          const [r] = await pingServers([address]);
          const s = toServer(address, r);
          probe = s.ok
            ? '\n探测：在线 ' + s.online + '/' + s.max + '，延迟 ' + (s.latency === null ? '--' : s.latency + 'ms') +
              (s.versionName && s.versionName !== '未知' ? '，版本 ' + s.versionName : '')
            : '\n探测失败：' + (s.error || '无法连接') + '（已保存，可稍后用 /server 复查）';
        } catch (e) {
          probe = '\n探测失败：' + errText(e) + '（已保存）';
        }
        await ctx.reply('✓ 已添加 ' + address + '（第 ' + pos + ' 位，共 ' + list.length + ' 台）' + probe + '\n' + listText(list));
      },
    },
    {
      // /server del <地址|位置>
      name: 'del',
      description: '删除服务器',
      minLevel: LEVELS.GROUP_ADMIN, // 1
      async handler(ctx: CommandContext): Promise<void> {
        if (!ctx.cfg.storage.ns(NS).available) {
          await ctx.reply('KV 未绑定，无法读取服务器列表。');
          return;
        }
        const store = sceneStore(ctx);
        if (!store) {
          await ctx.reply('无法确定当前会话（缺少 openid），无法读取服务器列表。');
          return;
        }
        if (ctx.args.length !== 1) {
          await ctx.reply('用法：/server del <地址|位置>\n例：/server del mc.jsumc.fun\n    /server del 2（删除第 2 台）');
          return;
        }
        const arg = (ctx.args[0] || '').trim();
        const list = await loadList(store);
        if (!list.length) {
          await ctx.reply(sceneLabel(ctx) + '还没有添加服务器。');
          return;
        }
        let idx = -1;
        if (/^\d+$/.test(arg)) {
          // 纯数字按位置（1 起）：列表长了以后比敲域名省事
          const pos = parseInt(arg, 10);
          if (pos < 1 || pos > list.length) {
            await ctx.reply('位置超出范围：当前列表 ' + list.length + ' 台，可填 1~' + list.length + '。\n' + listText(list));
            return;
          }
          idx = pos - 1;
        } else {
          idx = indexOf(list, arg);
          if (idx < 0) {
            await ctx.reply('列表里没有 ' + arg + '。\n' + listText(list));
            return;
          }
        }
        const removed = list.splice(idx, 1)[0];
        await saveList(store, list);
        await ctx.reply('✓ 已删除 ' + removed + '（原第 ' + (idx + 1) + ' 位，剩 ' + list.length + ' 台）' +
          (list.length ? '\n' + listText(list) : ''));
      },
    },
  ],
});
