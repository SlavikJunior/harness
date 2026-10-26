import { HarnessError } from "../core/errors.js"
import { readText, sha256, sha256Dir, writeTextAtomic, copyDir } from "../core/fs.js"
import { stableStringify } from "../core/hash.js"
import type { SkillMode } from "../manifest/schema.js"
import { scopeFrom, type ScopeInput } from "../scope.js"

/**
 * State-файл применённого состояния: `.harness/state.json`.
 * Отвечает на три вопроса: что применено, каким источником,
 * и совпадает ли текущее содержимое артефактов с применённым (drift).
 */

export const STATE_DIR = (input: ScopeInput): string => scopeFrom(input).harnessDir
export const STATE_FILE = (input: ScopeInput): string => scopeFrom(input).stateFile

export interface StateSkill {
  source: string
  name: string
  mode: SkillMode
  /** ref зеркала на момент применения */
  ref: string
  /** запрошенный пин (тег/ветка/sha), если был */
  pin?: string
  /** хеш содержимого (vendor) или целевой путь (reference) */
  sha?: string
  target?: string
  at: string
}

export interface StateInstructions {
  /** файл инструкций, которым управляет harness */
  file: string
  /** имя блока → sha256 каноничного содержимого */
  blocks: Record<string, string>
}

export interface StateAgent {
  /** sha256 каноничного markdown */
  sha: string
  at: string
}

export interface HarnessState {
  appliedAt: string
  /** ключи passthrough-конфига, записанные нам: dot-path → sha(value) */
  configKeys: Record<string, string>
  /** применённые mcp-серверы: имя → sha(value) */
  mcp: Record<string, string>
  skills: Record<string, StateSkill>
  /** управляемые блоки инструкций */
  instructions: StateInstructions
  /** markdown-агенты: имя → sha содержимого */
  agents: Record<string, StateAgent>
  /** записанный массив permissions: sha(value) — порядок правил значим */
  permissions?: StatePermissions
  /** записанный массив policies: sha(value) */
  policies?: StatePermissions
}

export interface StatePermissions {
  sha: string
}

export function emptyState(): HarnessState {
  return {
    appliedAt: "",
    configKeys: {},
    mcp: {},
    skills: {},
    instructions: { file: "", blocks: {} },
    agents: {},
  }
}

export async function loadState(input: ScopeInput): Promise<HarnessState> {
  const text = await readText(STATE_FILE(input))
  if (text === undefined) return emptyState()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HarnessError(
      `Файл состояния повреждён: ${STATE_FILE(input)}`,
      "удали файл состояния и повтори apply",
    )
  }
  const checked = stateSchema.safeParse(value)
  if (!checked.success) {
    const detail = checked.error.issues[0]?.message ?? "неизвестная ошибка"
    throw new HarnessError(
      `Файл состояния некорректен: ${STATE_FILE(input)} (${detail})`,
      "удали файл состояния и повтори apply",
    )
  }
  return {
    ...checked.data,
    instructions: checked.data.instructions ?? { file: "", blocks: {} },
    agents: checked.data.agents ?? {},
  }
}

export async function saveState(input: ScopeInput, state: HarnessState): Promise<void> {
  await writeTextAtomic(STATE_FILE(input), `${JSON.stringify(state, null, 2)}\n`)
}

/* Схема state-файла (минимальная, для защиты от мусора) */
import { z } from "zod"

const skillStateSchema = z.object({
  source: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(["vendor", "reference"]),
  ref: z.string().min(1),
  pin: z.string().min(1).optional(),
  sha: z.string().optional(),
  target: z.string().optional(),
  at: z.string().min(1),
})

const optional = (schema: z.ZodTypeAny) => z.record(z.string(), schema)
const stateSchema = z.object({
  appliedAt: z.string().min(1),
  configKeys: z.record(z.string(), z.string()),
  mcp: z.record(z.string(), z.string()),
  skills: z.record(z.string(), skillStateSchema),
  /* optional: state-файлы, созданные до появления инструкций */
  instructions: z
    .object({ file: z.string(), blocks: z.record(z.string(), z.string()) })
    .optional(),
  /* optional: state-файлы, созданные до появления permissions */
  permissions: z.object({ sha: z.string().min(1) }).optional(),
  /* optional: state-файлы, созданные до появления policies и агентов */
  policies: z.object({ sha: z.string().min(1) }).optional(),
  agents: z.record(z.string(), z.object({ sha: z.string().min(1), at: z.string().min(1) })).optional(),
})

/** Хеш директории (для vendor-скиллов). */
export async function hashSkillDir(dir: string): Promise<string> {
  return sha256Dir(dir)
}

/** Хеш произвольного JSON-значения (для mcp/конфиг-ключей) — порядок ключей не важен. */
export function hashValue(value: unknown): string {
  return sha256(stableStringify(value))
}

export { copyDir }
