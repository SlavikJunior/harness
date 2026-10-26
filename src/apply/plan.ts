import path from "node:path"
import os from "node:os"
import { parseTree, findNodeAtLocation, type JSONPath } from "jsonc-parser"
import { deepEqual, stableStringify } from "../core/hash.js"
import { sha256 } from "../core/fs.js"
import { isDirectory, readText, sha256Dir } from "../core/fs.js"
import { MANAGED_CONFIG_FILE } from "../manifest/file.js"
import type { SkillMode } from "../manifest/schema.js"
import { validateJsoncText } from "./config.js"
import { skillTargetDir } from "./desired.js"
import type { DesiredState } from "./types.js"
import type { HarnessState, StateSkill } from "./state.js"
import type { PlanAction, PlanItem, PlanReport } from "./types.js"

/** Diff текущего состояния проекта против желаемого → PlanReport. */

function valueAt(jsoncText: string, jsonPath: JSONPath): unknown {
  const tree = parseTree(jsoncText)
  if (tree === undefined) return undefined
  const node = findNodeAtLocation(tree, jsonPath)
  if (node === undefined) return undefined
  try {
    return JSON.parse(jsoncText.slice(node.offset, node.offset + node.length))
  } catch {
    return undefined
  }
}

function globalConfigFiles(): string[] {
  const base =
    process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ""
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config")
  return [path.join(base, "opencode", "opencode.json"), path.join(base, "opencode", "opencode.jsonc")]
}

export async function computePlan(
  projectRoot: string,
  desired: DesiredState,
  state: HarnessState,
): Promise<PlanReport> {
  const items: PlanItem[] = []
  const drift: string[] = []
  const conflicts: string[] = []

  const managedFile = MANAGED_CONFIG_FILE(projectRoot)
  const text = await readText(managedFile)

  if (text !== undefined) {
    const syntaxError = validateJsoncText(text)
    if (syntaxError !== undefined) {
      return { items, drift, conflicts, blocked: `${managedFile} не парсится как JSONC (${syntaxError})` }
    }
  }
  const fileExists = text !== undefined

  /* Конфиг: passthrough-ключи */
  const desiredPassthrough = Object.entries(desired.config)
  const previousKeys = Object.keys(state.configKeys)
  const desiredKeyNames = new Set(desiredPassthrough.map(([key]) => key))

  for (const [key, value] of desiredPassthrough) {
    const target = `config:${key}`
    if (!fileExists) {
      items.push({ kind: "config", action: "create", target, detail: stringifyShort(value) })
      continue
    }
    const current = valueAt(text, [key])
    const recordedHash = state.configKeys[key]
    const userEdited = recordedHash !== undefined && sha256(stableStringify(current)) !== recordedHash
    if (deepEqual(current, value)) {
      items.push({ kind: "config", action: "unchanged", target })
    } else {
      items.push({
        kind: "config",
        action: "update",
        target,
        detail: `→ ${stringifyShort(value)}`,
        warn: userEdited ? "правился вне harness" : undefined,
      })
      if (userEdited) drift.push(`${target}: правился вне harness, apply перезапишет значение`)
    }
  }
  for (const key of previousKeys) {
    if (!desiredKeyNames.has(key)) {
      items.push({ kind: "config", action: "remove", target: `config:${key}`, detail: "убран из манифеста" })
    }
  }

  /* MCP-серверы (штучно: deep-merge OpenCode сохраняет чужие серверы) */
  const desiredMcpEntries = Object.entries(desired.mcpServers)
  const previousMcpNames = Object.keys(state.mcp)
  const desiredMcpNames = new Set(desiredMcpEntries.map(([name]) => name))

  for (const [name, server] of desiredMcpEntries) {
    const target = `mcp:${name}`
    const jsonPath: JSONPath = ["mcp", "servers", name]
    const current = fileExists ? valueAt(text, jsonPath) : undefined
    const recordedHash = state.mcp[name]
    const userEdited =
      recordedHash !== undefined && current !== undefined && sha256(stableStringify(current)) !== recordedHash

    if (current === undefined) {
      items.push({
        kind: "mcp",
        action: "create",
        target,
        detail: describeServer(server),
        warn: recordedHash !== undefined ? "запись пропала — будет восстановлена" : undefined,
      })
      if (recordedHash !== undefined) drift.push(`${target}: запись пропала, будет восстановлена`)
      continue
    }
    if (deepEqual(current, server)) {
      items.push({ kind: "mcp", action: "unchanged", target })
    } else {
      items.push({
        kind: "mcp",
        action: "update",
        target,
        detail: describeServer(server),
        warn: userEdited ? "правился вне harness" : undefined,
      })
      if (userEdited) drift.push(`${target}: правился вне harness, apply перезапишет`)
    }
  }
  for (const name of previousMcpNames) {
    if (!desiredMcpNames.has(name)) {
      items.push({ kind: "mcp", action: "remove", target: `mcp:${name}`, detail: "убран из манифеста" })
    }
  }

  /* Скиллы */
  const desiredNames = new Set(desired.skills.map((skill) => skill.installName))
  const previousSkillNames = Object.keys(state.skills)

  for (const skill of desired.skills) {
    items.push(
      await assessSkill(skill.entry.mode ?? "vendor", skill, skillTargetDir(projectRoot, skill), state),
    )
  }
  for (const installName of previousSkillNames) {
    if (!desiredNames.has(installName)) {
      items.push({
        kind: "skill",
        action: "remove",
        target: `skill:${installName}`,
        detail: "убран из манифеста",
      })
    }
  }

  /* Конфликты перекрытия пользовательских конфигов */
  await scanConflicts(projectRoot, desired, conflicts)

  return { items: items.toSorted(sortItems), drift, conflicts }
}

function describeServer(server: { type: string; command?: string[]; url?: string }): string {
  return server.type === "local" ? `local: ${(server.command ?? []).join(" ")}` : `remote: ${server.url ?? ""}`
}

function stringifyShort(value: unknown): string {
  const text = JSON.stringify(value)
  return text !== undefined && text.length > 80 ? `${text.slice(0, 77)}…` : text ?? "undefined"
}

function sortItems(a: PlanItem, b: PlanItem): number {
  const kindOrder: Record<PlanItem["kind"], number> = { skill: 0, mcp: 1, config: 2 }
  const actionOrder: Record<PlanAction, number> = { create: 0, update: 1, remove: 2, unchanged: 3 }
  return (
    kindOrder[a.kind] - kindOrder[b.kind] ||
    actionOrder[a.action] - actionOrder[b.action] ||
    a.target.localeCompare(b.target)
  )
}

type SkillDescriptor = { installName: string; sourceDir: string; sourceRef: string; entry: { name: string; source: string; mode?: SkillMode } }

async function assessSkill(
  mode: SkillMode,
  skill: SkillDescriptor,
  targetDir: string,
  state: HarnessState,
): Promise<PlanItem> {
  const target = `skill:${skill.installName}`
  const recorded: StateSkill | undefined = state.skills[skill.installName]
  const targetPresent = await isDirectory(targetDir)

  if (mode === "vendor") {
    if (!targetPresent) {
      return {
        kind: "skill",
        action: "create",
        target,
        detail: `vendor ← ${skill.entry.source}`,
        warn: recorded !== undefined ? "артефакт удалён — будет восстановлен" : undefined,
      }
    }
    const currentHash = await sha256Dir(targetDir)
    const sourceHash = await sha256Dir(skill.sourceDir)
    if (currentHash === sourceHash) return { kind: "skill", action: "unchanged", target }
    const userEdited = recorded?.sha !== undefined && currentHash !== recorded.sha
    return {
      kind: "skill",
      action: "update",
      target,
      detail: `vendor ← ${skill.entry.source}`,
      warn: userEdited ? "правился вручную — будет заменён из источника" : undefined,
    }
  }

  /* reference: symlink в директорию зеркала */
  const link = await readlinkSafe(targetDir)
  if (link === undefined) {
    return {
      kind: "skill",
      action: "create",
      target,
      detail: `reference → ${skill.sourceDir}`,
      warn: recorded !== undefined ? "ссылка пропала — будет восстановлена" : undefined,
    }
  }
  if (link === skill.sourceDir) return { kind: "skill", action: "unchanged", target }
  return {
    kind: "skill",
    action: "update",
    target,
    detail: `reference → ${skill.sourceDir}`,
    warn: recorded?.target !== undefined && recorded.target !== link ? "цель правилась вне harness" : undefined,
  }
}

async function readlinkSafe(link: string): Promise<string | undefined> {
  try {
    const { lstatSync, readlinkSync } = await import("node:fs")
    if (!lstatSync(link).isSymbolicLink()) return undefined
    const raw = readlinkSync(link)
    /* Без realpath: macOS /var → /private/var менял бы сравнение с sourceDir */
    return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(link), raw)
  } catch {
    return undefined
  }
}

/** Ключи/серверы, которые инструмент перекроет в чужих конфигах (для вывода плана). */
async function scanConflicts(
  projectRoot: string,
  desired: DesiredState,
  conflicts: string[],
): Promise<void> {
  const files = [
    path.join(projectRoot, "opencode.json"),
    path.join(projectRoot, "opencode.jsonc"),
    ...globalConfigFiles(),
  ]
  for (const file of files) {
    const text = await readText(file)
    if (text === undefined || validateJsoncText(text) !== undefined) continue
    for (const [key, value] of Object.entries(desired.config)) {
      const current = valueAt(text, [key])
      if (current === undefined || deepEqual(current, value)) continue
      conflicts.push(`config:${key} перекроет значение из ${file}`)
    }
    for (const [name, server] of Object.entries(desired.mcpServers)) {
      const current = valueAt(text, ["mcp", "servers", name])
      if (current === undefined || deepEqual(current, server)) continue
      conflicts.push(`mcp:${name} заменит одноимённый сервер из ${file}`)
    }
  }
}
