import path from "node:path"
import os from "node:os"
import { type JSONPath } from "jsonc-parser"
import { deepEqual, stableStringify } from "../core/hash.js"
import { sha256 } from "../core/fs.js"
import { isDirectory, readText, sha256Dir } from "../core/fs.js"
import { MANAGED_CONFIG_FILE } from "../manifest/file.js"
import type { PermissionRule, SkillMode } from "../manifest/schema.js"
import { validateJsoncText, valueAt } from "./config.js"
import { skillTargetDir } from "./desired.js"
import { sameLinkTarget } from "./link.js"
import type { DesiredState } from "./types.js"
import type { HarnessState, StateSkill } from "./state.js"
import type { PlanAction, PlanItem, PlanReport } from "./types.js"
import { maskSecrets, maskText } from "../secrets/scan.js"
import {
  instructionsFilePath,
  normalizeInstructionContent,
  parseInstructionBlocks,
} from "./instructions.js"
import { normalizeAgentContent } from "./agents.js"
import { scopeFrom, type ScopeInput } from "../scope.js"

/** Diff текущего состояния проекта против желаемого → PlanReport. */

function globalConfigFiles(): string[] {
  const base =
    process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ""
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config")
  return [path.join(base, "opencode", "opencode.json"), path.join(base, "opencode", "opencode.jsonc")]
}

export async function computePlan(
  input: ScopeInput,
  desired: DesiredState,
  state: HarnessState,
): Promise<PlanReport> {
  const items: PlanItem[] = []
  const drift: string[] = []
  const conflicts: string[] = []
  const scope = scopeFrom(input)

  const managedFile = MANAGED_CONFIG_FILE(scope)
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
    const current = fileExists ? valueAt(text, [key]) : undefined
    if (current === undefined) {
      items.push({ kind: "config", action: "create", target, detail: stringifyShort(maskSecrets(value, key)) })
      continue
    }
    const recordedHash = state.configKeys[key]
    const userEdited = recordedHash !== undefined && sha256(stableStringify(current)) !== recordedHash
    if (deepEqual(current, value)) {
      items.push({ kind: "config", action: "unchanged", target })
    } else {
      items.push({
        kind: "config",
        action: "update",
        target,
        detail: `→ ${stringifyShort(maskSecrets(value, key))}`,
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

  /* Permissions и policies (V2): массивы правил, порядок значим */
  assessRuleArray({
    kind: "permissions",
    target: "permissions",
    current: fileExists ? valueAt(text, ["permissions"]) : undefined,
    desiredRules: desired.permissions,
    recorded: state.permissions?.sha,
    items,
    drift,
  })
  assessRuleArray({
    kind: "policies",
    target: "policies",
    current: fileExists ? valueAt(text, ["policies"]) : undefined,
    desiredRules: desired.policies,
    recorded: state.policies?.sha,
    items,
    drift,
  })

  /* Markdown-агенты: файл целиком наш, чужие имена не трогаются */
  await assessAgents(desired, state, items, drift)

  /* Инструкции (AGENTS.md): управляемые блоки */
  const instructionsBlocked = await assessInstructions(scope, desired, state, items, drift)
  if (instructionsBlocked !== undefined) {
    return { items, drift, conflicts, blocked: instructionsBlocked }
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
      await assessSkill(skill.entry.mode ?? "vendor", skill, skillTargetDir(scope, skill), state),
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

  /* Конфликты перекрытия пользовательских конфигов (только проектный скоуп) */
  if (scope.kind === "project") await scanConflicts(scope.root, desired, conflicts)

  return { items: items.toSorted(sortItems), drift, conflicts }
}

/** Русский счётчик правил: 1 правило, 2 правила, 5 правил. */
function rulesLabel(count: number): string {
  const mod10 = count % 10
  const mod100 = count % 100
  const word =
    mod10 === 1 && mod100 !== 11
      ? "правило"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
        ? "правила"
        : "правил"
  return `${count} ${word}`
}

/** Что именно изменилось: количество или только порядок (порядок в V2 значим). */
function describeRulesChange(current: unknown, desired: readonly PermissionRule[]): string {
  if (!Array.isArray(current)) return rulesLabel(desired.length)
  if (current.length !== desired.length) return `правил ${current.length} → ${desired.length}`
  const signature = (rules: readonly unknown[]): string => rules.map((rule) => stableStringify(rule)).toSorted().join("\n")
  if (signature(current) === signature(desired)) return "порядок правил изменён"
  return `правил ${current.length} → ${desired.length}`
}

/**
 * Массив правил одним top-level ключом (permissions или policies).
 * Порядок значим (побеждает последнее совпадение), поэтому сравнение —
 * глубокое и упорядоченное. Чужие правила без записи в state не удаляются:
 * ownership только свой.
 */
function assessRuleArray(options: {
  kind: "permissions" | "policies"
  target: string
  current: unknown
  desiredRules: readonly PermissionRule[] | undefined
  recorded: string | undefined
  items: PlanItem[]
  drift: string[]
}): void {
  const { kind, target, current, desiredRules, recorded, items, drift } = options

  if (desiredRules === undefined) {
    if (recorded !== undefined) {
      items.push({ kind, action: "remove", target, detail: "убран из манифеста" })
    }
    return
  }

  if (current === undefined) {
    items.push({
      kind,
      action: "create",
      target,
      detail: rulesLabel(desiredRules.length),
      warn: recorded !== undefined ? "правила удалены — будут восстановлены" : undefined,
    })
    if (recorded !== undefined) drift.push(`${target}: правила удалены из конфига, будут восстановлены`)
    return
  }
  if (deepEqual(current, desiredRules)) {
    items.push({ kind, action: "unchanged", target })
    return
  }

  const userEdited = recorded !== undefined && sha256(stableStringify(current)) !== recorded
  items.push({
    kind,
    action: "update",
    target,
    detail: describeRulesChange(current, desiredRules),
    warn:
      recorded === undefined
        ? `в конфиге уже были ${target} вне harness — будут заменены`
        : userEdited
          ? "правился вне harness"
          : undefined,
  })
  if (userEdited) drift.push(`${target}: правился вне harness, apply перезапишет правила`)
}

/**
 * Markdown-агенты: сравнение по каноническому содержимому файла.
 * Файл, которого нет в state, считается чужим: при совпадении имени
 * он будет перезаписан с предупреждением, без имени — не трогается.
 */
async function assessAgents(
  desired: DesiredState,
  state: HarnessState,
  items: PlanItem[],
  drift: string[],
): Promise<void> {
  const desiredNames = new Set(desired.agents.map((agent) => agent.name))

  for (const agent of desired.agents) {
    const target = `agent:${agent.name}`
    const recorded = state.agents[agent.name]?.sha
    const current = await readText(agent.file)

    if (current === undefined) {
      items.push({
        kind: "agent",
        action: "create",
        target,
        detail: agent.relativePath,
        warn: recorded !== undefined ? "файл удалён — будет восстановлен" : undefined,
      })
      if (recorded !== undefined) drift.push(`${target}: файл удалён, будет восстановлен`)
      continue
    }

    const normalized = normalizeAgentContent(current)
    if (normalized === agent.content) {
      items.push({ kind: "agent", action: "unchanged", target })
      continue
    }

    const userEdited = recorded !== undefined && sha256(normalized) !== recorded
    items.push({
      kind: "agent",
      action: "update",
      target,
      detail: agent.relativePath,
      warn:
        recorded === undefined
          ? "файл уже был вне harness — будет заменён"
          : userEdited
            ? "правился вне harness"
            : undefined,
    })
    if (userEdited) drift.push(`${target}: правился вне harness, apply перезапишет файл`)
  }

  for (const name of Object.keys(state.agents)) {
    if (!desiredNames.has(name)) {
      items.push({ kind: "agent", action: "remove", target: `agent:${name}`, detail: "убран из манифеста" })
    }
  }
}

/**
 * Оценка управляемых блоков инструкций: create/update/remove + drift.
 * Повреждённые маркеры блокируют apply, чтобы не перезаписать чужой текст.
 */
async function assessInstructions(
  input: ScopeInput,
  desired: DesiredState,
  state: HarnessState,
  items: PlanItem[],
  drift: string[],
): Promise<string | undefined> {
  const relative = desired.instructions.file
  const file = instructionsFilePath(input, relative)
  const text = await readText(file)
  const parsed = parseInstructionBlocks(text ?? "")
  if (parsed.errors.length > 0) {
    return `${relative}: повреждены маркеры блоков (${parsed.errors.join("; ")})`
  }

  const recorded = state.instructions.blocks
  const previousFile = state.instructions.file
  const fileChanged = previousFile !== "" && previousFile !== relative

  /* Смена файла: старые блоки будут убраны из прежнего файла */
  if (fileChanged) {
    const previousText = await readText(instructionsFilePath(input, previousFile))
    if (previousText !== undefined) {
      const previousParsed = parseInstructionBlocks(previousText)
      if (previousParsed.errors.length > 0) {
        drift.push(`instructions: ${previousFile}: повреждены маркеры — старые блоки не будут удалены`)
      } else {
        for (const name of Object.keys(recorded)) {
          if (!previousParsed.blocks.has(name)) continue
          items.push({
            kind: "instructions",
            action: "remove",
            target: `instructions:${name}`,
            detail: `из ${previousFile} (файл сменился на ${relative})`,
          })
        }
      }
    }
  }

  for (const block of desired.instructions.blocks) {
    const target = `instructions:${block.name}`
    const current = parsed.blocks.get(block.name)

    if (current === undefined) {
      const restored = !fileChanged && recorded[block.name] !== undefined
      items.push({
        kind: "instructions",
        action: "create",
        target,
        detail: `→ ${relative}`,
        warn: restored ? "блок удалён — будет восстановлен" : undefined,
      })
      if (restored) drift.push(`${target}: блок удалён из ${relative}, будет восстановлен`)
      continue
    }

    if (current === normalizeInstructionContent(block.content)) {
      items.push({ kind: "instructions", action: "unchanged", target })
      continue
    }

    const recordedHash = recorded[block.name]
    const userEdited =
      !fileChanged && recordedHash !== undefined && recordedHash !== sha256(current)
    items.push({
      kind: "instructions",
      action: "update",
      target,
      detail: `→ ${relative}`,
      warn: userEdited ? "правился вне harness" : undefined,
    })
    if (userEdited) drift.push(`${target}: правился вне harness, apply перезапишет блок`)
  }

  if (!fileChanged) {
    const desiredNames = new Set(desired.instructions.blocks.map((block) => block.name))
    for (const name of Object.keys(recorded)) {
      if (desiredNames.has(name) || !parsed.blocks.has(name)) continue
      items.push({
        kind: "instructions",
        action: "remove",
        target: `instructions:${name}`,
        detail: "убран из манифеста",
      })
    }
  }

  return undefined
}

function describeServer(server: { type: string; command?: string[]; url?: string }): string {
  return server.type === "local"
    ? `local: ${(server.command ?? []).map((argument) => maskText(argument)).join(" ")}`
    : `remote: ${maskText(server.url ?? "", "url")}`
}

function stringifyShort(value: unknown): string {
  const text = JSON.stringify(value)
  return text !== undefined && text.length > 80 ? `${text.slice(0, 77)}…` : text ?? "undefined"
}

function sortItems(a: PlanItem, b: PlanItem): number {
  const kindOrder: Record<PlanItem["kind"], number> = {
    skill: 0,
    mcp: 1,
    permissions: 2,
    policies: 3,
    agent: 4,
    instructions: 5,
    config: 6,
  }
  const actionOrder: Record<PlanAction, number> = { create: 0, update: 1, remove: 2, unchanged: 3 }
  return (
    kindOrder[a.kind] - kindOrder[b.kind] ||
    actionOrder[a.action] - actionOrder[b.action] ||
    a.target.localeCompare(b.target)
  )
}

type SkillDescriptor = {
  installName: string
  sourceDir: string
  sourceRef: string
  entry: { name: string; source: string; ref?: string; mode?: SkillMode }
}

/** Отображение источника с пином: `android-skills@v1.1.0`. */
function skillOrigin(skill: SkillDescriptor): string {
  return skill.entry.ref === undefined ? skill.entry.source : `${skill.entry.source}@${skill.entry.ref}`
}

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
        detail: `vendor ← ${skillOrigin(skill)}`,
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
      detail: `vendor ← ${skillOrigin(skill)}`,
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
  if (sameLinkTarget(link, targetDir, skill.sourceDir)) {
    return { kind: "skill", action: "unchanged", target }
  }
  const editedTarget =
    recorded?.target !== undefined && !sameLinkTarget(link, targetDir, recorded.target)
  return {
    kind: "skill",
    action: "update",
    target,
    detail: `reference → ${skill.sourceDir}`,
    warn: editedTarget ? "цель правилась вне harness" : undefined,
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
