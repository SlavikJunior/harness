import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { HarnessError } from "../core/errors.js"
import { displayPath, scopeFrom, type Scope, type ScopeInput, type ScopeKind } from "../scope.js"
import { referenceLinkType } from "./link.js"
import { agentFilePath } from "./agents.js"
import { instructionsFilePath } from "./instructions.js"
import { skillTargetDir } from "./desired.js"
import type { DesiredState, PlanReport } from "./types.js"
import type { HarnessState } from "./state.js"

/**
 * Снапшоты перед apply и откат (`apply --undo`).
 *
 * Перед записью harness копирует только те артефакты, которые план реально
 * меняет, плюс state и управляемый конфиг. Снапшот — стек: `--undo` берёт
 * последний и удаляет его после успешного восстановления. Манифест не
 * копируется и не меняется: после отката `plan` честно покажет расхождение.
 */

export const BACKUP_VERSION = 1
export const BACKUP_RETENTION = 5

export interface BackupEntry {
  /** абсолютный путь оригинального артефакта */
  original: string
  existed: boolean
  kind?: "file" | "dir" | "link"
  linkTarget?: string
  /** путь копии относительно директории снапшота */
  stored?: string
}

export interface BackupRecord {
  version: number
  createdAt: string
  scope: ScopeKind
  /** пункты плана, которые применялись */
  items: string[]
  state: BackupEntry
  config: BackupEntry
  gitignore?: BackupEntry
  instructions: Record<string, BackupEntry>
  agents: Record<string, BackupEntry>
  skills: Record<string, BackupEntry>
}

export interface RestoreAction {
  /** абсолютный путь */
  path: string
  /** путь для сообщения (относительный/`~/…`) */
  display: string
  action: "restore" | "remove"
}

export interface RestoreOutcome {
  backupDir: string
  displayDir: string
  dryRun: boolean
  actions: RestoreAction[]
  restored: number
  removed: number
}

export function backupsRoot(input: ScopeInput): string {
  return path.join(scopeFrom(input).harnessDir, "backups")
}

/** Снапшоты от новых к старым (имя директории — ISO-время). */
export async function listBackups(input: ScopeInput): Promise<string[]> {
  const root = backupsRoot(input)
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".partial"))
    .map((entry) => path.join(root, entry.name))
    .toSorted((left, right) => path.basename(right).localeCompare(path.basename(left)))
}

/**
 * Копия артефакта в снапшот. `stored` — путь относительно корня снапшота,
 * чтобы снапшот можно было атомарно переименовать и перенести.
 */
async function capture(original: string, stored: string, base: string): Promise<BackupEntry> {
  let stat
  try {
    stat = await fs.lstat(original)
  } catch {
    return { original, existed: false }
  }
  const destination = path.join(base, stored)
  if (stat.isSymbolicLink()) {
    return { original, existed: true, kind: "link", linkTarget: await fs.readlink(original) }
  }
  if (stat.isDirectory()) {
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.cp(original, destination, { recursive: true })
    return { original, existed: true, kind: "dir", stored }
  }
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(original, destination)
  return { original, existed: true, kind: "file", stored }
}

function timestamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
}

/** Удаляет старые снапшоты, оставляя последние BACKUP_RETENTION. */
async function prune(scope: Scope): Promise<void> {
  const dirs = await listBackups(scope)
  for (const dir of dirs.slice(BACKUP_RETENTION)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * Снимает снапшот артефактов, которые изменит план.
 * undefined — менять нечего, снапшот не нужен.
 */
export async function createBackup(
  input: ScopeInput,
  desired: DesiredState,
  plan: PlanReport,
  state: HarnessState,
): Promise<string | undefined> {
  const scope = scopeFrom(input)
  const changed = plan.items.filter((item) => item.action !== "unchanged")
  if (changed.length === 0) return undefined

  const root = backupsRoot(scope)
  const name = timestamp()
  /* Собираем во временную директорию: недописанный снапшот не должен считаться валидным */
  const partial = path.join(root, `${name}.partial`)
  const dir = path.join(root, name)
  await fs.mkdir(partial, { recursive: true })

  try {
    const record: BackupRecord = {
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      scope: scope.kind,
      items: changed.map((item) => item.target),
      state: await capture(scope.stateFile, "files/state.json", partial),
      config: await capture(scope.configFile, "files/config", partial),
      instructions: {},
      agents: {},
      skills: {},
    }
    if (scope.kind === "project") {
      record.gitignore = await capture(path.join(scope.root, ".gitignore"), "files/gitignore", partial)
    }

    /* Инструкции: текущий файл + прежний при смене файла */
    const instructionFiles = new Set<string>([desired.instructions.file])
    if (state.instructions.file !== "" && state.instructions.file !== desired.instructions.file) {
      instructionFiles.add(state.instructions.file)
    }
    for (const relative of instructionFiles) {
      record.instructions[relative] = await capture(
        instructionsFilePath(scope, relative),
        `files/instructions/${encodeURIComponent(relative)}`,
        partial,
      )
    }

    const touched = (prefix: string): Set<string> =>
      new Set(
        changed
          .filter((item) => item.target.startsWith(prefix))
          .map((item) => item.target.slice(prefix.length)),
      )

    for (const name of touched("agent:")) {
      record.agents[name] = await capture(agentFilePath(scope, name), `files/agents/${name}.md`, partial)
    }
    for (const name of touched("skill:")) {
      const skill = desired.skills.find((candidate) => candidate.installName === name)
      const original = skill === undefined ? path.join(scope.skillsDir, name) : skillTargetDir(scope, skill)
      record.skills[name] = await capture(original, `files/skills/${name}`, partial)
    }

    await fs.writeFile(path.join(partial, "backup.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8")
    await fs.rename(partial, dir)
  } catch (error) {
    await fs.rm(partial, { recursive: true, force: true })
    throw error
  }

  await prune(scope)
  return dir
}

const entrySchema = z.object({
  original: z.string().min(1),
  existed: z.boolean(),
  kind: z.enum(["file", "dir", "link"]).optional(),
  linkTarget: z.string().optional(),
  stored: z.string().optional(),
})

const recordSchema = z.object({
  version: z.literal(BACKUP_VERSION),
  createdAt: z.string().min(1),
  scope: z.enum(["project", "global"]),
  items: z.array(z.string()),
  state: entrySchema,
  config: entrySchema,
  gitignore: entrySchema.optional(),
  instructions: z.record(z.string(), entrySchema),
  agents: z.record(z.string(), entrySchema),
  skills: z.record(z.string(), entrySchema),
})

async function readRecord(dir: string): Promise<BackupRecord> {
  const file = path.join(dir, "backup.json")
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch {
    throw new HarnessError(`Снапшот повреждён: ${file}`, "удали директорию снапшота и повтори apply")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HarnessError(`Снапшот повреждён: ${file}`, "удали директорию снапшота и повтори apply")
  }
  const checked = recordSchema.safeParse(parsed)
  if (!checked.success) {
    throw new HarnessError(
      `Снапшот несовместим: ${file} (${checked.error.issues[0]?.message ?? "неизвестная ошибка"})`,
      "снапшоты создаёт только harness; удали повреждённую директорию",
    )
  }
  return checked.data
}

function storedPath(backupDir: string, entry: BackupEntry): string {
  if (entry.stored === undefined) {
    throw new HarnessError(`В снапшоте нет файла: ${entry.original}`)
  }
  const root = path.resolve(backupDir)
  const resolved = path.resolve(root, entry.stored)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new HarnessError(`Снапшот ссылается за свои пределы: ${entry.stored}`, "снапшот повреждён")
  }
  return resolved
}

async function restoreEntry(entry: BackupEntry, display: string, backupDir: string): Promise<RestoreAction> {
  if (!entry.existed) {
    await fs.rm(entry.original, { recursive: true, force: true })
    return { path: entry.original, display, action: "remove" }
  }
  const stored = entry.stored === undefined ? undefined : storedPath(backupDir, entry)
  if (stored === undefined) {
    throw new HarnessError(`В снапшоте нет копии: ${entry.original}`, "снапшот повреждён — откат невозможен")
  }
  if (!(await pathExistsSafe(stored))) {
    throw new HarnessError(`В снапшоте нет файла: ${stored}`, "снапшот повреждён — откат невозможен")
  }
  await fs.rm(entry.original, { recursive: true, force: true })
  await fs.mkdir(path.dirname(entry.original), { recursive: true })
  if (entry.kind === "link") {
    if (entry.linkTarget === undefined) {
      throw new HarnessError(`В снапшоте нет цели ссылки: ${entry.original}`)
    }
    await fs.symlink(entry.linkTarget, entry.original, referenceLinkType())
  } else if (entry.kind === "dir") {
    await fs.cp(stored, entry.original, { recursive: true })
  } else {
    await fs.copyFile(stored, entry.original)
  }
  return { path: entry.original, display, action: "restore" }
}

async function pathExistsSafe(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Откат последнего apply. Без --dry-run снапшот расходуется (стек undo):
 * повторный `--undo` откатит предыдущий apply.
 */
export async function restoreBackup(
  input: ScopeInput,
  options: { dryRun?: boolean } = {},
): Promise<RestoreOutcome> {
  const scope = scopeFrom(input)
  const [latest] = await listBackups(scope)
  if (latest === undefined) {
    throw new HarnessError(
      "Нет снапшотов для отката",
      "снапшоты создаются автоматически при harness apply",
    )
  }
  const record = await readRecord(latest)
  if (record.scope !== scope.kind) {
    throw new HarnessError(`Снапшот принадлежит другому скоупу: ${record.scope}`)
  }

  const entries: BackupEntry[] = [
    ...Object.values(record.instructions),
    ...Object.values(record.agents),
    ...Object.values(record.skills),
    ...(record.gitignore === undefined ? [] : [record.gitignore]),
    record.config,
    record.state,
  ]
  const planned: RestoreAction[] = entries.map((entry) => ({
    path: entry.original,
    display: displayPath(scope, entry.original),
    action: entry.existed ? "restore" : "remove",
  }))

  if (options.dryRun === true) {
    return {
      backupDir: latest,
      displayDir: displayPath(scope, latest),
      dryRun: true,
      actions: planned,
      restored: planned.filter((action) => action.action === "restore").length,
      removed: planned.filter((action) => action.action === "remove").length,
    }
  }

  const actions: RestoreAction[] = []
  for (const entry of entries) {
    actions.push(await restoreEntry(entry, displayPath(scope, entry.original), latest))
  }
  await fs.rm(latest, { recursive: true, force: true })
  return {
    backupDir: latest,
    displayDir: displayPath(scope, latest),
    dryRun: false,
    actions,
    restored: actions.filter((action) => action.action === "restore").length,
    removed: actions.filter((action) => action.action === "remove").length,
  }
}
