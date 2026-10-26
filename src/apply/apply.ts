import { promises as fs } from "node:fs"
import path from "node:path"
import { HarnessError } from "../core/errors.js"
import { copyDir, readText, writeTextAtomic } from "../core/fs.js"
import { MANAGED_CONFIG_FILE } from "../manifest/file.js"
import { ConfigEditor, SCHEMA_URL } from "./config.js"
import { skillTargetDir } from "./desired.js"
import type { DesiredState, PlanItem, PlanReport } from "./types.js"
import { hashSkillDir, hashValue, saveState, type HarnessState, type StateSkill } from "./state.js"
import type { SkillMode } from "../manifest/schema.js"

/** Исполнение плана: приводит проект к DesiredState (идемпотентно). */

export interface ApplyOutcome {
  /** изменённые пункты (create|update|remove) */
  applied: PlanItem[]
  dryRun: boolean
}

const GITIGNORE_LINE = ".harness/"

async function ensureGitignore(projectRoot: string): Promise<boolean> {
  const file = path.join(projectRoot, ".gitignore")
  const current = await readText(file)
  if (current !== undefined) {
    const present = current.split("\n").some((line) => line.trim() === GITIGNORE_LINE)
    if (present) return false
    const suffix = current.endsWith("\n") ? "" : "\n"
    await writeTextAtomic(file, `${current}${suffix}${GITIGNORE_LINE}\n`)
    return true
  }
  await writeTextAtomic(file, `${GITIGNORE_LINE}\n`)
  return true
}

async function buildNextState(desired: DesiredState): Promise<HarnessState> {
  const state: HarnessState = {
    appliedAt: new Date().toISOString(),
    configKeys: {},
    mcp: {},
    skills: {},
  }
  for (const [key, value] of Object.entries(desired.config)) state.configKeys[key] = hashValue(value)
  for (const [name, server] of Object.entries(desired.mcpServers)) state.mcp[name] = hashValue(server)
  for (const skill of desired.skills) {
    const mode: SkillMode = skill.entry.mode ?? "vendor"
    const record: StateSkill = {
      source: skill.entry.source,
      name: skill.entry.name,
      mode,
      ref: skill.sourceRef,
      at: state.appliedAt,
    }
    if (mode === "vendor") record.sha = await hashSkillDir(skill.sourceDir)
    else record.target = skill.sourceDir
    state.skills[skill.installName] = record
  }
  return state
}

/** Конвергенция: исполняет план (create/update/remove) и фиксирует state. */
export async function applyDesired(
  projectRoot: string,
  desired: DesiredState,
  plan: PlanReport,
  options: { dryRun?: boolean } = {},
): Promise<ApplyOutcome> {
  if (plan.blocked !== undefined) throw new HarnessError("Apply заблокирован", plan.blocked)
  if (options.dryRun === true) {
    return { applied: plan.items.filter((item) => item.action !== "unchanged"), dryRun: true }
  }

  /* Конфиг: $schema + passthrough + mcp.servers */
  const managedFile = MANAGED_CONFIG_FILE(projectRoot)
  const editor = ConfigEditor.from(await readText(managedFile))
  let configChanged = editor.set(["$schema"], SCHEMA_URL)

  for (const [key, value] of Object.entries(desired.config)) {
    configChanged = editor.set([key], value) || configChanged
  }
  for (const [name, server] of Object.entries(desired.mcpServers)) {
    configChanged = editor.set(["mcp", "servers", name], server) || configChanged
  }
  for (const item of plan.items) {
    if (item.action !== "remove") continue
    if (item.target.startsWith("config:")) {
      configChanged = editor.remove([item.target.slice("config:".length)]) || configChanged
    } else if (item.target.startsWith("mcp:")) {
      configChanged = editor.remove(["mcp", "servers", item.target.slice("mcp:".length)]) || configChanged
    }
  }
  if (configChanged) await writeTextAtomic(managedFile, `${editor.currentText.trimEnd()}\n`)

  /* Скиллы: установка из манифеста */
  for (const skill of desired.skills) {
    const targetDir = skillTargetDir(projectRoot, skill)
    if ((skill.entry.mode ?? "vendor") === "reference") {
      await fs.mkdir(path.dirname(targetDir), { recursive: true })
      await fs.rm(targetDir, { recursive: true, force: true })
      await fs.symlink(skill.sourceDir, targetDir, "dir")
    } else {
      await copyDir(skill.sourceDir, targetDir)
    }
  }
  /* Скиллы: удаление по плану */
  for (const item of plan.items) {
    if (item.action !== "remove" || !item.target.startsWith("skill:")) continue
    const installName = item.target.slice("skill:".length)
    await fs.rm(path.join(projectRoot, ".opencode", "skills", installName), { recursive: true, force: true })
  }

  /* State + gitignore */
  await ensureGitignore(projectRoot)
  await saveState(projectRoot, await buildNextState(desired))

  return { applied: plan.items.filter((item) => item.action !== "unchanged"), dryRun: false }
}
