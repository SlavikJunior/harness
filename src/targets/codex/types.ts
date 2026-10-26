import type { InstructionBlock } from "../../apply/instructions.js"
import type { AgentDefinition, MCPServer, SkillMode } from "../../manifest/schema.js"
import type { ScopeKind } from "../../scope.js"

/** Общие типы Codex-экспорта: желаемое состояние, отчёт, state. */

export type CodexSection = "skills" | "instructions" | "mcp" | "agents" | "config"

export type CodexStatus = "mapped" | "approximate" | "skipped" | "conflict" | "unchanged" | "forced"

export interface CodexItem {
  section: CodexSection
  name: string
  status: CodexStatus
  message?: string
  target?: string
}

export interface CodexDesiredSkill {
  name: string
  sourceDir: string
  mode: SkillMode
  origin: "manifest" | "live"
  ref?: string
}

export interface CodexDesiredAgent {
  name: string
  definition: AgentDefinition
  origin: "manifest" | "live"
}

export type CodexInstructionsMode = "shared" | "copy" | "managed" | "none"

export interface CodexInstructionsDesired {
  mode: CodexInstructionsMode
  targetFile: string
  /** файл OpenCode-инструкций, если он есть */
  sourceFile?: string
  sourceText?: string
  blocks: InstructionBlock[]
}

export interface CodexDesired {
  skills: CodexDesiredSkill[]
  agents: CodexDesiredAgent[]
  mcp: Record<string, MCPServer>
  mcpOrigins: Record<string, "manifest" | "live">
  instructions: CodexInstructionsDesired
  /** предупреждения/пропуски, собранные при инвентаризации */
  items: CodexItem[]
  /** top-level ключи OpenCode-конфига, которые не переносятся автоматически */
  configKeys: string[]
}

export interface CodexExportResult {
  scope: ScopeKind
  codexHome: string
  dryRun: boolean
  items: CodexItem[]
  written: string[]
  removed: string[]
  backupDir?: string
  errors: string[]
}

export interface CodexStateSkill {
  path: string
  mode: SkillMode
  sourceDir: string
  hash: string
}

export interface CodexStateAgent {
  path: string
  hash: string
}

export interface CodexStateInstructions {
  file: string
  fullCopy: boolean
  hash: string
  blocks: Record<string, string>
}

export interface CodexState {
  version: 1
  scope: ScopeKind
  codexHome: string
  exportedAt: string
  skills: Record<string, CodexStateSkill>
  agents: Record<string, CodexStateAgent>
  mcp: {
    file: string
    servers: Record<string, string>
  }
  instructions?: CodexStateInstructions
}

export function emptyCodexState(scope: ScopeKind, codexHome: string): CodexState {
  return {
    version: 1,
    scope,
    codexHome,
    exportedAt: "",
    skills: {},
    agents: {},
    mcp: { file: "", servers: {} },
  }
}

/** Итог по статусам — для человеческого вывода и strict-кода. */
export function summarizeCodexItems(items: readonly CodexItem[]): Record<CodexStatus, number> {
  const summary: Record<CodexStatus, number> = {
    mapped: 0,
    approximate: 0,
    skipped: 0,
    conflict: 0,
    unchanged: 0,
    forced: 0,
  }
  for (const item of items) summary[item.status] += 1
  return summary
}

/** Есть ли причины для exit 1 в --strict. */
export function codexStrictFailure(result: CodexExportResult): boolean {
  return result.errors.length > 0 || result.items.some((item) =>
    item.status === "approximate" || item.status === "skipped" || item.status === "conflict",
  )
}
