// 命令系统：注册内置命令、解析 /<command> [args]、查找命令（含别名）。
import type { Command } from './types.js';
import permissionCmd from '../commands/permission.js';
import debugCmd from '../commands/debug.js';

// 每个命令模块导出：name, aliases?, description, scenes:['group'|'private'], minLevel, handler(ctx)
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
