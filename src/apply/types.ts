import type { SkillEntry, SkillMode, MCPServer } from "../manifest/schema.js"
import type { SkillItem } from "../catalog/types.js"

/** Желаемое состояние: что манифест + каталог говорят применить. */

export interface DesiredSkill {
  entry: SkillEntry
  /** имя директории в .opencode/skills/ */
  installName: string
  /** абсолютный путь к директории скилла в зеркале */
  sourceDir: string
  /** ref зеркала (git sha / путь) */
  sourceRef: string
  item: SkillItem
}

export interface DesiredState {
  /** passthrough: top-level ключи .opencode/opencode.jsonc */
  config: Record<string, unknown>
  mcpServers: Record<string, MCPServer>
  skills: DesiredSkill[]
}

export type PlanAction = "create" | "update" | "remove" | "unchanged"

export interface PlanItem {
  kind: "skill" | "mcp" | "config"
  action: PlanAction
  /** читаемое имя цели, например `navigation-3`, `mcp:gradle`, `config:model` */
  target: string
  detail?: string
  warn?: string
}

export interface PlanReport {
  items: PlanItem[]
  drift: string[]
  conflicts: string[]
  /** true, если целевой конфиг повреждён и apply небезопасен */
  blocked?: string
}
