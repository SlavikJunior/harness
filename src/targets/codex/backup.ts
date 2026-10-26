import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { HarnessError } from "../../core/errors.js"
import { referenceLinkType } from "../../apply/link.js"
import type { Scope } from "../../scope.js"
import { displayCodexPath, type CodexEnvironment } from "./paths.js"

/**
 * Снапшоты Codex-экспорта. Перед записью копируются только затрагиваемые
 * файлы/директории; глобальный config.toml не перезаписывается целиком.
 */

export const CODEX_BACKUP_VERSION = 1
export const CODEX_BACKUP_RETENTION = 5

export interface CodexBackupEntry {
  original: string
  existed: boolean
  kind?: "file" | "dir" | "link"
  linkTarget?: string
  stored?: string
}

interface CodexBackupRecord {
  version: number
  createdAt: string
  scope: "project" | "global"
  entries: CodexBackupEntry[]
}

export interface CodexRestoreAction {
  path: string
  display: string
  action: "restore" | "remove"
}

export interface CodexRestoreOutcome {
  backupDir: string
  displayDir: string
  dryRun: boolean
  actions: CodexRestoreAction[]
  restored: number
  removed: number
}

function timestamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
}

export async function listCodexBackups(backupsDir: string): Promise<string[]> {
  const entries = await fs.readdir(backupsDir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".partial"))
    .map((entry) => path.join(backupsDir, entry.name))
    .toSorted((left, right) => path.basename(right).localeCompare(path.basename(left)))
}

async function capture(original: string, stored: string, base: string): Promise<CodexBackupEntry> {
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

async function prune(backupsDir: string): Promise<void> {
  const dirs = await listCodexBackups(backupsDir)
  for (const dir of dirs.slice(CODEX_BACKUP_RETENTION)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

export async function createCodexBackup(
  scope: Scope,
  backupsDir: string,
  targets: readonly string[],
): Promise<string | undefined> {
  const unique = [...new Set(targets)].filter((target) => target.trim() !== "")
  if (unique.length === 0) return undefined
  await fs.mkdir(backupsDir, { recursive: true })
  const name = timestamp()
  const partial = path.join(backupsDir, `${name}.partial`)
  const dir = path.join(backupsDir, name)
  await fs.mkdir(partial, { recursive: true })
  try {
    const entries: CodexBackupEntry[] = []
    for (const [index, target] of unique.entries()) {
      entries.push(await capture(target, `files/${index}`, partial))
    }
    const record: CodexBackupRecord = {
      version: CODEX_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      scope: scope.kind,
      entries,
    }
    await fs.writeFile(path.join(partial, "backup.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8")
    await fs.rename(partial, dir)
    await prune(backupsDir)
    return dir
  } catch (error) {
    await fs.rm(partial, { recursive: true, force: true })
    throw error
  }
}

const entrySchema = z.object({
  original: z.string().min(1),
  existed: z.boolean(),
  kind: z.enum(["file", "dir", "link"]).optional(),
  linkTarget: z.string().optional(),
  stored: z.string().optional(),
})

const recordSchema = z.object({
  version: z.literal(CODEX_BACKUP_VERSION),
  createdAt: z.string().min(1),
  scope: z.enum(["project", "global"]),
  entries: z.array(entrySchema),
})

function storedPath(backupDir: string, entry: CodexBackupEntry): string {
  if (entry.stored === undefined) throw new HarnessError(`В снапшоте нет копии: ${entry.original}`)
  const root = path.resolve(backupDir)
  const resolved = path.resolve(root, entry.stored)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new HarnessError(`Снапшот Codex ссылается за свои пределы: ${entry.stored}`)
  }
  return resolved
}

async function restoreEntry(entry: CodexBackupEntry, backupDir: string, display: string): Promise<CodexRestoreAction> {
  if (!entry.existed) {
    await fs.rm(entry.original, { recursive: true, force: true })
    return { path: entry.original, display, action: "remove" }
  }
  const stored = storedPath(backupDir, entry)
  if (!(await fs.stat(stored).then(() => true).catch(() => false))) {
    throw new HarnessError(`В снапшоте нет файла: ${stored}`, "снапшот повреждён — откат невозможен")
  }
  await fs.rm(entry.original, { recursive: true, force: true })
  await fs.mkdir(path.dirname(entry.original), { recursive: true })
  if (entry.kind === "link") {
    if (entry.linkTarget === undefined) throw new HarnessError(`В снапшоте нет цели ссылки: ${entry.original}`)
    await fs.symlink(entry.linkTarget, entry.original, referenceLinkType())
  } else if (entry.kind === "dir") {
    await fs.cp(stored, entry.original, { recursive: true })
  } else {
    await fs.copyFile(stored, entry.original)
  }
  return { path: entry.original, display, action: "restore" }
}

export async function restoreCodexBackup(
  scope: Scope,
  backupsDir: string,
  options: { dryRun?: boolean; environment?: CodexEnvironment } = {},
): Promise<CodexRestoreOutcome> {
  const [latest] = await listCodexBackups(backupsDir)
  if (latest === undefined) {
    throw new HarnessError("Нет снапшотов Codex для отката", "снапшоты создаются при harness codex export")
  }
  const raw = await fs.readFile(path.join(latest, "backup.json"), "utf8").catch(() => undefined)
  if (raw === undefined) {
    throw new HarnessError(`Снапшот Codex повреждён: ${latest}`, "удали директорию снапшота")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HarnessError(`Снапшот Codex повреждён: ${latest}`, "удали директорию снапшота")
  }
  const checked = recordSchema.safeParse(parsed)
  if (!checked.success) {
    throw new HarnessError(`Снапшот Codex несовместим: ${latest}`, "удали директорию снапшота")
  }
  if (checked.data.scope !== scope.kind) {
    throw new HarnessError(`Снапшот Codex принадлежит другому скоупу: ${checked.data.scope}`)
  }

  const planned: CodexRestoreAction[] = checked.data.entries.map((entry) => ({
    path: entry.original,
    display: displayCodexPath(scope, entry.original, options.environment),
    action: entry.existed ? "restore" : "remove",
  }))
  if (options.dryRun === true) {
    return {
      backupDir: latest,
      displayDir: displayCodexPath(scope, latest, options.environment),
      dryRun: true,
      actions: planned,
      restored: planned.filter((action) => action.action === "restore").length,
      removed: planned.filter((action) => action.action === "remove").length,
    }
  }

  const actions: CodexRestoreAction[] = []
  for (const entry of checked.data.entries) {
    actions.push(
      await restoreEntry(entry, latest, displayCodexPath(scope, entry.original, options.environment)),
    )
  }
  await fs.rm(latest, { recursive: true, force: true })
  return {
    backupDir: latest,
    displayDir: displayCodexPath(scope, latest, options.environment),
    dryRun: false,
    actions,
    restored: actions.filter((action) => action.action === "restore").length,
    removed: actions.filter((action) => action.action === "remove").length,
  }
}
