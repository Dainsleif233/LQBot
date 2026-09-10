// 命令系统：注册内置命令、解析 /<command> [args]、查找命令（含别名）。
import type { Command, SubCommand } from './types.js';
import permissionCmd from '../commands/permission.js';
import debugCmd from '../commands/debug.js';
// 每个命令模块 export default defineCommand({...})（见 src/lib/define.ts），在此挂载进 commands 数组。
export const commands: Command[] = [permissionCmd, debugCmd];
export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}
// 从消息文本解析命令。返回 null 表示不是命令。
// 会先剥离可能残留的 @机器人 片段。
export function parseCommand(text: string): ParsedCommand | null {
  let s = String(text || '');
  s = s.replace(/^<@!?[0-9A-Za-z_]+>\s*/, '').replace(/^@\S+\s*/, '').trim();
  if (!s.startsWith('/')) return null;
  const parts = s.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { name: parts[0].toLowerCase(), args: parts.slice(1), raw: s };
}
export function findCommand(name: string): Command | undefined {
  const n = String(name || '').toLowerCase();
  return commands.find(c => c.name === n || (c.aliases && c.aliases.includes(n)));
}
// 查找父节点（命令或子命令）的子命令（含别名）；未声明或未命中返回 undefined。
export function findSubCommand(parent: { subcommands?: SubCommand[] }, name: string): SubCommand | undefined {
  const n = String(name || '').toLowerCase();
  return parent.subcommands?.find(s => s.name === n || (s.aliases && s.aliases.includes(n)));
}
