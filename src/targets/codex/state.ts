import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { sha256 } from "../../core/fs.js"
import { stableStringify } from "../../core/hash.js"
import type { Scope } from "../../scope.js"
import { emptyCodexState, type CodexState } from "./types.js"

/**
 * Состояние Codex-экспорта: что именно создал harness.
 *
 * Отдельный файл, чтобы не смешивать владение OpenCode-артефактами и
 * Codex-файлами. Без state harness не имеет права удалять/перезаписывать
 * чужие `.codex`/`.agents` файлы.
 */

const skillSchema = z.object({
  path: z.string().min(1),
  mode: z.enum(["vendor", "reference"]),
  sourceDir: z.string().min(1),
  hash: z.string().min(1),
})

const agentSchema = z.object({
  path: z.string().min(1),
  hash: z.string().min(1),
})

const instructionsSchema = z.object({
  file: z.string().min(1),
  fullCopy: z.boolean(),
  hash: z.string().min(1),
  blocks: z.record(z.string(), z.string()),
})

const stateSchema = z.object({
  version: z.literal(1),
  scope: z.enum(["project", "global"]),
  codexHome: z.string().min(1),
  exportedAt: z.string(),
  skills: z.record(z.string(), skillSchema),
  agents: z.record(z.string(), agentSchema),
  mcp: z.object({
    file: z.string(),
    servers: z.record(z.string(), z.string()),
  }),
  instructions: instructionsSchema.optional(),
})

export interface LoadedCodexState {
  state: CodexState
  warning?: string
}

export async function loadCodexState(scope: Scope, file: string, codexHome: string): Promise<LoadedCodexState> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch {
    return { state: emptyCodexState(scope.kind, codexHome) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      state: emptyCodexState(scope.kind, codexHome),
      warning: `state Codex повреждён (${file}); удали его и повтори export`,
    }
  }
  const checked = stateSchema.safeParse(parsed)
  if (!checked.success) {
    return {
      state: emptyCodexState(scope.kind, codexHome),
      warning: `state Codex несовместим (${file}); удали его и повтори export`,
    }
  }
  if (checked.data.scope !== scope.kind) {
    return {
      state: emptyCodexState(scope.kind, codexHome),
      warning: `state Codex относится к другому скоупу (${checked.data.scope}); удали ${file} и повтори export`,
    }
  }
  if (checked.data.codexHome !== codexHome) {
    return {
      state: emptyCodexState(scope.kind, codexHome),
      warning: `state Codex создан для другого CODEX_HOME (${checked.data.codexHome}); удали ${file} и повтори export`,
    }
  }
  return { state: checked.data }
}

export async function writeCodexState(file: string, state: CodexState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  const text = `${JSON.stringify(state, null, 2)}\n`
  await fs.writeFile(temp, text, "utf8")
  await fs.rename(temp, file)
}

export function hashValue(value: unknown): string {
  return sha256(stableStringify(value))
}

export function hashText(text: string): string {
  return sha256(text)
}

