import path from "node:path"
import { HarnessError } from "../core/errors.js"
import { readText, sha256, sha256Dir, writeTextAtomic, copyDir } from "../core/fs.js"
import { stableStringify } from "../core/hash.js"
import type { SkillMode } from "../manifest/schema.js"

/**
 * State-файл применённого состояния: `.harness/state.json`.
 * Отвечает на три вопроса: что применено, каким источником,
 * и совпадает ли текущее содержимое артефактов с применённым (drift).
 */

export const STATE_DIR = (projectRoot: string): string => path.join(projectRoot, ".harness")
export const STATE_FILE = (projectRoot: string): string => path.join(STATE_DIR(projectRoot), "state.json")

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

export interface HarnessState {
  appliedAt: string
  /** ключи passthrough-конфига, записанные нам: dot-path → sha(value) */
  configKeys: Record<string, string>
  /** применённые mcp-серверы: имя → sha(value) */
  mcp: Record<string, string>
  skills: Record<string, StateSkill>
  /** управляемые блоки инструкций */
  instructions: StateInstructions
}

export function emptyState(): HarnessState {
  return { appliedAt: "", configKeys: {}, mcp: {}, skills: {}, instructions: { file: "", blocks: {} } }
}

export async function loadState(projectRoot: string): Promise<HarnessState> {
  const text = await readText(STATE_FILE(projectRoot))
  if (text === undefined) return emptyState()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HarnessError(
      `Файл состояния повреждён: ${STATE_FILE(projectRoot)}`,
      "удали файл состояния и повтори apply",
    )
  }
  const checked = stateSchema.safeParse(value)
  if (!checked.success) {
    const detail = checked.error.issues[0]?.message ?? "неизвестная ошибка"
    throw new HarnessError(
      `Файл состояния некорректен: ${STATE_FILE(projectRoot)} (${detail})`,
      "удали файл состояния и повтори apply",
    )
  }
  return { ...checked.data, instructions: checked.data.instructions ?? { file: "", blocks: {} } }
}

export async function saveState(projectRoot: string, state: HarnessState): Promise<void> {
  await writeTextAtomic(STATE_FILE(projectRoot), `${JSON.stringify(state, null, 2)}\n`)
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
