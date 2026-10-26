import type {
  AgentDefinition,
  PolicyRule,
  SkillEntry,
  SkillMode,
  MCPServer,
  PermissionRule,
} from "../manifest/schema.js"
import type { SkillItem } from "../catalog/types.js"
import type { InstructionBlock } from "./instructions.js"

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

export interface DesiredInstructions {
  /** файл инструкций относительно корня проекта */
  file: string
  /** управляемые блоки в порядке манифеста */
  blocks: InstructionBlock[]
}

export interface DesiredAgent {
  name: string
  definition: AgentDefinition
  /** канонический markdown, который пишется в файл */
  content: string
  /** абсолютный путь файла агента */
  file: string
  /** путь относительно корня проекта (для сообщений) */
  relativePath: string
}

export interface DesiredState {
  /** passthrough: top-level ключи .opencode/opencode.jsonc */
  config: Record<string, unknown>
  mcpServers: Record<string, MCPServer>
  skills: DesiredSkill[]
  instructions: DesiredInstructions
  /** markdown-агенты, отсортированы по имени */
  agents: DesiredAgent[]
  /** V2 permissions; undefined — секции в манифесте нет (не управляем) */
  permissions?: PermissionRule[]
  /** V2 policies (hard-deny); undefined — секции нет (не управляем) */
  policies?: PolicyRule[]
}

export type PlanAction = "create" | "update" | "remove" | "unchanged"

export interface PlanItem {
  kind: "skill" | "mcp" | "permissions" | "policies" | "agent" | "instructions" | "config"
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
