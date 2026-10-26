import path from "node:path"
import type { Manifest } from "../manifest/load.js"
import type { CatalogIndex, SkillItem } from "../catalog/types.js"
import { HarnessError } from "../core/errors.js"
import type { DesiredSkill, DesiredState } from "./types.js"
import type { SkillEntry } from "../manifest/schema.js"
import { DEFAULT_INSTRUCTIONS_FILE, type InstructionBlock } from "./instructions.js"

/** Сборка DesiredState: манифест + каталог → что именно применить. */

export const SKILLS_DIR = (projectRoot: string): string => path.join(projectRoot, ".opencode", "skills")

function assertSafeName(value: string, field: string): void {
  if (value.includes("/") || value.includes("\\") || value.startsWith(".")) {
    throw new HarnessError(`Недопустимое имя: ${field}="${value}"`)
  }
}

/**
 * Имя директории установки. Если один и тот же name встречается у
 * нескольких источников — всем таким скиллам добавляется префикс источника,
 * чтобы выбор был детерминированным и не зависел от порядка в манифесте.
 */
export function installNames(entries: SkillEntry[]): Map<number, string> {
  const sourcesPerName = new Map<string, Set<string>>()
  for (const entry of entries) {
    const set = sourcesPerName.get(entry.name) ?? new Set<string>()
    set.add(entry.source)
    sourcesPerName.set(entry.name, set)
  }
  const result = new Map<number, string>()
  entries.forEach((entry, index) => {
    const ambiguous = (sourcesPerName.get(entry.name)?.size ?? 0) > 1
    result.set(index, ambiguous ? `${entry.source}-${entry.name}` : entry.name)
  })
  return result
}

/** Какие refs источника нужны манифесту: undefined — HEAD, строка — пин. */
export function catalogRefs(manifest: Manifest): Record<string, (string | undefined)[]> {
  const result = new Map<string, Set<string | undefined>>()
  for (const entry of manifest.skills ?? []) {
    const set = result.get(entry.source) ?? new Set<string | undefined>()
    set.add(entry.ref)
    result.set(entry.source, set)
  }
  return Object.fromEntries([...result].map(([source, set]) => [source, [...set]]))
}

function resolveSkill(catalog: CatalogIndex, entry: SkillEntry): SkillItem {
  const all = catalog.skills.filter((item) => item.source === entry.source)
  if (all.length === 0) {
    throw new HarnessError(
      `Скилл ${entry.name}: источник "${entry.source}" не найден или пуст`,
      "Список источников: harness skills list",
    )
  }
  /* pin: у источника могут быть зеркала разных refs — берём только нужный */
  const candidates = all.filter((item) => item.pin === entry.ref)
  const exact = candidates.find((item) => item.name === entry.name)
  if (exact !== undefined) return exact
  if (candidates.length === 0) {
    const pins = [...new Set(all.map((item) => item.pin ?? "HEAD"))].join(", ")
    throw new HarnessError(
      `Скилл ${entry.name}: источник "${entry.source}" не зеркалирован на ref "${entry.ref}"`,
      `Доступные refs: ${pins}. Проверь ref в манифесте`,
    )
  }
  const similar = candidates
    .filter((item) => item.name.includes(entry.name) || entry.name.includes(item.name))
    .slice(0, 5)
    .map((item) => `${item.name} (${item.relDir})`)
  const shown = similar.length > 0 ? `Похожие в "${entry.source}": ${similar.join(", ")}` : `Доступно в "${entry.source}": ${candidates.slice(0, 8).map((item) => item.name).join(", ")}`
  throw new HarnessError(`Скилл ${entry.name} не найден в источнике "${entry.source}"`, shown)
}

/** Манифест + каталог → DesiredState (чистая от ФС, кроме проверки имён). */
export function buildDesiredState(
  root: string,
  manifest: Manifest,
  catalog: CatalogIndex,
): DesiredState {
  const entries = manifest.skills ?? []
  entries.forEach((entry) => {
    assertSafeName(entry.name, "name")
    assertSafeName(entry.source, "source")
  })
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = `${entry.source}\u0000${entry.name}\u0000${entry.ref ?? ""}`
    if (seen.has(key)) {
      throw new HarnessError(
        `Скилл ${entry.source}/${entry.name} указан в манифесте дважды`,
        "Оставь одну запись на скилл",
      )
    }
    seen.add(key)
  }
  const names = installNames(entries)
  const targets = new Map<string, string>()
  entries.forEach((entry, index) => {
    const installName = names.get(index) as string
    const key = `${entry.source}/${entry.name}${entry.ref === undefined ? "" : `@${entry.ref}`}`
    const existing = targets.get(installName)
    if (existing !== undefined) {
      throw new HarnessError(
        `Конфликт установки: ${existing} и ${key} ставятся в одну директорию "${installName}"`,
        "Для одного скилла можно указать только один ref",
      )
    }
    targets.set(installName, key)
  })

  const skills: DesiredSkill[] = entries.map((entry, index) => {
    const item = resolveSkill(catalog, entry)
    return {
      entry,
      installName: names.get(index) as string,
      sourceDir: item.dir,
      sourceRef: item.ref,
      item,
    }
  })

  return {
    config: { ...(manifest.config ?? {}) },
    mcpServers: { ...(manifest.mcp ?? {}) },
    skills,
    instructions: {
      file: manifest.instructions?.file ?? DEFAULT_INSTRUCTIONS_FILE,
      blocks: (Object.entries(manifest.instructions?.blocks ?? {}) as [string, string][]).map(
        ([name, content]): InstructionBlock => ({ name, content }),
      ),
    },
  }
}

/** Пути установки всех скиллов. */
export function skillTargetDir(root: string, skill: DesiredSkill): string {
  return path.join(SKILLS_DIR(root), skill.installName)
}
