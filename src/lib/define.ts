// 命令编写辅助：defineCommand 统一声明命令与多级子命令，补默认值并提供完整类型提示。
// 唯一约定：命令模块 export default defineCommand({...})，再 import 到 src/lib/registry.ts
// 的 commands 数组（register.ts 也以 registry 为唯一数据源）。详见 docs/PLUGIN-DEV.md。
import type { Command, CommandContext, Scene, SubCommand } from './types.js';

/** 子命令声明。handler 可省略：省略时该节点为分组节点，进入时自动回复子命令用法。 */
export interface SubCommandInput {
  name: string;
  description: string;
  aliases?: string[];
  /** 生效权限等级；缺省继承父级生效等级 */
  minLevel?: number;
  handler?: (ctx: CommandContext) => Promise<void>;
  subcommands?: SubCommandInput[];
}

export interface CommandInput {
  name: string;
  description: string;
  aliases?: string[];
  /** 缺省 ['group', 'private'] */
  scenes?: Scene[];
  /** 必填：显式声明权限等级，避免遗漏导致默认放开 */
  minLevel: number;
  /** 缺省时自动回复子命令用法（需要声明 subcommands） */
  handler?: (ctx: CommandContext) => Promise<void>;
  subcommands?: SubCommandInput[];
}

// name/aliases 统一 trim + 小写：registry 匹配是「小写输入比对原值」，
// 不规范（如 'Game'、'HI'）会静默失配，且面板名字大小写还会不一致。
function normName(s: string, where: string): string {
  const v = String(s || '').trim().toLowerCase();
  if (!v) throw new Error('defineCommand：' + where + ' 的 name 不能为空');
  return v;
}

// minLevel 运行时校验：NaN/undefined 参与 level < minLevel 比较恒为 false（权限 fail-open）。
function checkLevel(level: unknown, where: string): void {
  const n = level as number;
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    throw new Error('defineCommand：' + where + ' 的 minLevel 必须为 0-3 的整数，当前为 ' + String(level));
  }
}

function normalizeSub(input: SubCommandInput, parentPath: string): SubCommand {
  const name = normName(input.name, parentPath);
  const where = parentPath + ' ' + name;
  if (input.minLevel !== undefined) checkLevel(input.minLevel, where);
  return {
    name,
    description: input.description,
    aliases: (input.aliases || []).map((a) => normName(a, where)),
    minLevel: input.minLevel,
    handler: input.handler,
    subcommands: input.subcommands ? input.subcommands.map((s) => normalizeSub(s, where)) : undefined,
  };
}

/** 声明一个命令：规范化 name/aliases、校验 minLevel，并递归规范化子命令。 */
export function defineCommand(input: CommandInput): Command {
  const name = normName(input.name, '');
  checkLevel(input.minLevel, name);
  return {
    name,
    description: input.description,
    aliases: (input.aliases || []).map((a) => normName(a, name)),
    scenes: input.scenes || ['group', 'private'],
    minLevel: input.minLevel,
    handler: input.handler,
    subcommands: input.subcommands ? input.subcommands.map((s) => normalizeSub(s, name)) : undefined,
  };
}
