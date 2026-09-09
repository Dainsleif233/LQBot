// 将 src/commands/ 下注册的命令「同步」为 QQ 机器人「指令面板」。
// 拆分策略：等级 <3 的命令进「全量面板」（target_type=all，所有人可见）；
//          等级 >=3 的命令单独进「超管专属面板」（target_type=specific + 超管 openid）。
//          这样 only_admin 的面板级副作用被消除——普通命令不再因存在超管命令而被误限。
// 流程：获取某场景现有面板（内存快照） -> 删除全部 -> 按当前命令重建（可能多块面板）；
//       任一步出错则回滚：再次获取并删除当前面板，再把内存中的原有面板原样还原。
// 参考：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/
//   GET    /v2/panels?scope=...            -> { records:[{panel_id, scope, target_type, panel:{items,remark}, ...}], next_cursor, is_end }
//   DELETE /v2/panels/{panel_id}
//   POST   /v2/panels                      （10 QPM，每机器人最多 20 个面板）
// 元素规则：name 不带 /；别名也各自注册；minLevel>=1 -> only_admin=true。
// 凭证：APP_ID / APP_SECRET（或 WEBHOOK_SECRET）/ SUPER_ADMIN_OPENID，来自环境变量或仓库根目录 .env。
// 域名：QQ_API_BASE 默认 https://api.bot.qq.com（官方 2026-08-10 起统一域名）；
//       沙箱/旧域可显式设 QQ_API_BASE 覆盖（如 https://sandbox.api.sgroup.qq.com）。
// 运行：npm run register   （即 npx tsx scripts/register.ts；或 node --experimental-strip-types scripts/register.ts）

import { existsSync, readFileSync } from 'node:fs';
// 直接导入命令注册表：与运行时同一数据源，避免正则漏解析导致面板与实现不一致
import { commands } from '../src/lib/registry.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REMARK = 'LQBot 指令面板';
const ADMIN_REMARK = 'LQBot 管理员面板';
const SCOPES: string[] = ['group', 'c2c'];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- 读取 .env（不覆盖已有环境变量） ----------
function loadEnv(): void {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

// ---------- 从 src/commands/*.ts 提取已注册命令（与命令系统同一数据源） ----------
interface Cmd {
  name: string;
  aliases: string[];
  description: string;
  minLevel: number;
}
const API_GAP_MS = 350; // 面板写操作之间的间隔，避免撞 10 QPM 限频

function collectCommands(): Cmd[] {
  return commands.map((c) => ({
    name: c.name,
    aliases: c.aliases || [],
    description: String(c.description || '').slice(0, 30), // 面板元素 desc 上限 30 字符
    minLevel: c.minLevel,
  }));
}

// ---------- QQ OpenAPI ----------
async function getAppAccessToken(appId: string, appSecret: string): Promise<string> {
  const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 字段名必须是 appId（只发 clientId 会报 appid invalid）；多带 clientId 兼容旧文档。
    body: JSON.stringify({ appId, clientId: appId, clientSecret: appSecret }),
  });
  const text = await resp.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* keep {} */ }
  if (!data.access_token) throw new Error('getAppAccessToken 失败: ' + text);
  return data.access_token;
}

async function api(apiBase: string, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(apiBase + path, {
    method,
    headers: { Authorization: 'QQBot ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(method + ' ' + path + ' -> ' + resp.status + ' ' + text);
  try { return JSON.parse(text); } catch { return text; }
}

interface PanelRecord {
  panel_id: string;
  scope: string;
  target_type?: string;
  user_openids?: string[];
  group_openids?: string[];
  panel?: { items?: PanelItem[]; remark?: string; version?: number; user_openids?: string[]; group_openids?: string[] };
  created_at?: string;
}
interface PanelItem { type: 'command'; name: string; desc: string; only_admin?: boolean; }
interface Panel { items: PanelItem[]; remark: string; }

async function listPanels(apiBase: string, token: string, scope: string): Promise<PanelRecord[]> {
  const all: PanelRecord[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const qs = '?scope=' + scope + '&limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r: any = await api(apiBase, token, 'GET', '/v2/panels' + qs);
    const records = Array.isArray(r?.records) ? r.records : [];
    all.push(...records);
    if (r?.is_end === true || !r?.next_cursor) break;
    cursor = r.next_cursor;
  }
  return all;
}

async function deleteAllPanels(apiBase: string, token: string, scope: string): Promise<void> {
  const records = await listPanels(apiBase, token, scope);
  for (const r of records) {
    await api(apiBase, token, 'DELETE', '/v2/panels/' + r.panel_id);
    console.log('[' + scope + '] 已删除面板 ' + r.panel_id);
    await sleep(API_GAP_MS);
  }
}

// 命令 -> 面板元素（name 不带 /，别名也各自注册）
function toItems(cmds: Cmd[]): PanelItem[] {
  const items: PanelItem[] = [];
  for (const c of cmds) {
    const onlyAdmin = c.minLevel >= 1;
    for (const raw of [c.name, ...c.aliases]) {
      const n = raw.replace(/^\/+/, '');
      if (!n) continue;
      items.push({ type: 'command', name: n, desc: c.description, only_admin: onlyAdmin });
    }
  }
  return items;
}

// 拆分：等级 <3 -> 全量面板（group 与 c2c 都注册）；
//       等级 >=3 -> 仅 c2c（私聊）面板按用户精确限定；群聊面板无法按用户精确限定，故群聊不注册。
function buildNewPanels(cmds: Cmd[], superAdminOpenid: string, scope: string): any[] {
  const general = cmds.filter((c) => c.minLevel < 3);
  const bodies: any[] = [];
  if (general.length) {
    bodies.push({ scope, target_type: 'all', panel: { items: toItems(general), remark: REMARK } });
  }
  // 等级>=3 的命令仅在私聊(c2c)面板按用户 openid 精确限定到超级管理员；群聊不注册。
  // 注意：QQ 端对被 specific 面板命中的用户（超管）可能只展示该面板、隐藏 all 面板，
  // 因此管理员面板放入「全部命令」，确保超管在私聊也能看到通用命令（如 /debug）。
  if (scope === 'c2c') {
    if (cmds.length) {
      const body: any = {
        scope,
        target_type: 'all',
        panel: { items: toItems(cmds), remark: ADMIN_REMARK },
      };
      if (superAdminOpenid) {
        body.target_type = 'specific';
        body.user_openids = [superAdminOpenid];
      } else {
        console.warn('[' + scope + '] 存在等级>=3 的命令但未配置 SUPER_ADMIN_OPENID，私聊管理员面板按全量创建（仅 item 级 only_admin）。');
      }
      bodies.push(body);
    }
  }
  return bodies;
}

// 回滚：重新获取并删光当前面板，再把内存中的原有面板原样还原
async function rollback(apiBase: string, token: string, scope: string, originals: PanelRecord[]): Promise<void> {
  console.error('[' + scope + '] 开始回滚：清理当前面板并还原 ' + originals.length + ' 个原有面板');
  await deleteAllPanels(apiBase, token, scope);
  for (const o of originals) {
    const body: any = {
      scope: o.scope,
      target_type: o.target_type || 'all',
      panel: { items: o.panel?.items || [], remark: o.panel?.remark || REMARK },
    };
    if (o.target_type === 'specific') {
      const uo = o.user_openids || o.panel?.user_openids;
      const go = o.group_openids || o.panel?.group_openids;
      if (o.scope === 'group' && go) body.group_openids = go;
      else if (uo) body.user_openids = uo;
    }
    await api(apiBase, token, 'POST', '/v2/panels', body);
    console.log('[' + scope + '] 已还原原有面板（remark=' + (o.panel?.remark || '(无)') + '）');
    await sleep(API_GAP_MS);
  }
}

// 单场景同步：快照 -> 删光 -> 重建（出错回滚）
async function syncScope(apiBase: string, token: string, scope: string, cmds: Cmd[], superAdminOpenid: string): Promise<void> {
  const originals = await listPanels(apiBase, token, scope); // 1. 获取原有面板，放内存
  console.log('[' + scope + '] 快照到 ' + originals.length + ' 个原有面板');

  await deleteAllPanels(apiBase, token, scope); // 2. 删除所有面板

  try {
    const bodies = buildNewPanels(cmds, superAdminOpenid, scope); // 3. 重建（可能多块面板）
    const ids: string[] = [];
    let total = 0;
    for (const body of bodies) {
      const out = await api(apiBase, token, 'POST', '/v2/panels', body);
      ids.push(out?.panel_id ?? '(未返回)');
      total += body.panel.items.length;
      await sleep(API_GAP_MS);
    }
    console.log('[' + scope + '] 已创建 ' + bodies.length + ' 个指令面板 ' + ids.join(',') + '（元素数=' + total + '）');
  } catch (e) {
    console.error('[' + scope + '] 重建失败：' + (e instanceof Error ? e.message : e));
    await rollback(apiBase, token, scope, originals); // 出错：再删 + 还原
    throw e;
  }
}

// ---------- main ----------
async function main(): Promise<void> {
  loadEnv();
  const appId = process.env.APP_ID;
  const appSecret = process.env.APP_SECRET || process.env.WEBHOOK_SECRET;
  const superAdminOpenid = process.env.SUPER_ADMIN_OPENID || '';
  if (!appId || !appSecret) {
    console.error('缺少 APP_ID / APP_SECRET（或 WEBHOOK_SECRET）：请设置环境变量或配置仓库根目录 .env');
    process.exit(1);
  }
  const apiBase = (process.env.QQ_API_BASE || 'https://api.bot.qq.com').replace(/\/+$/, '');

  const cmds = collectCommands();
  if (!cmds.length) {
    console.error('未在 src/commands/ 下解析到任何命令，请检查命令模块的导出。');
    process.exit(1);
  }
  const allNames = cmds.flatMap((c) => [c.name, ...c.aliases]).map((n) => '/' + n);
  console.log('同步命令：' + allNames.join('、'));

  const token = await getAppAccessToken(appId, appSecret);
  let failed = false;
  for (const scope of SCOPES) {
    try {
      await syncScope(apiBase, token, scope, cmds, superAdminOpenid);
    } catch (e) {
      failed = true;
      console.error('[' + scope + '] 同步出错，已回滚；继续下一场景。');
    }
    await sleep(500);
  }
  console.log('完成。');
  if (failed) {
    console.error('存在场景同步失败，退出码 1。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('失败：' + (e instanceof Error ? e.message : e));
  process.exit(1);
});
