import path from "node:path"
import { promises as fs } from "node:fs"
import { isDirectory, pathExists, readText, sha256 } from "../core/fs.js"
import { MANAGED_CONFIG_FILE } from "../manifest/file.js"
import { agentFilePath } from "./agents.js"
import { valueAt } from "./config.js"
import {
  instructionsFilePath,
  normalizeInstructionContent,
  parseInstructionBlocks,
} from "./instructions.js"
import { maskSecrets, maskText } from "../secrets/scan.js"
import type { PlanAction, PlanItem, PlanReport, DesiredState } from "./types.js"
import type { HarnessState } from "./state.js"
import { scopeFrom, type ScopeInput } from "../scope.js"

/**
 * Подробный diff: что именно изменится в конфиге, скиллах, агентах и блоках
 * инструкций. `plan` отвечает «что», `diff` — «как»: значения маскируются,
 * поэтому diff безопасно печатать в терминал и CI.
 */

export type DiffLineType = "add" | "remove" | "change" | "context"

export interface DiffLine {
  type: DiffLineType
  text: string
}

export interface DiffEntry {
  kind: PlanItem["kind"]
  target: string
  action: PlanAction
  detail?: string
  lines: DiffLine[]
  note?: string
}

export interface DiffReport {
  entries: DiffEntry[]
  blocked?: string
}

const MAX_DIFF_LINES = 200
const MAX_DIR_FILES = 100
const LCS_LIMIT = 2_000_000

interface DiffLinesResult {
  lines: DiffLine[]
  truncated: boolean
}

/** Построчный diff: LCS для небольших файлов, иначе префикс/суффикс. */
export function diffText(before: string | undefined, after: string | undefined): DiffLinesResult {
  if (before === undefined && after === undefined) return { lines: [], truncated: false }
  const left = (before ?? "").replace(/\r\n/g, "\n").split("\n")
  const right = (after ?? "").replace(/\r\n/g, "\n").split("\n")
  if (before === undefined) return { lines: right.map((text) => ({ type: "add", text })), truncated: false }
  if (after === undefined) return { lines: left.map((text) => ({ type: "remove", text })), truncated: false }

  const operations =
    left.length * right.length <= LCS_LIMIT ? lcsDiff(left, right) : prefixSuffixDiff(left, right)
  const lines = operations.length > MAX_DIFF_LINES ? operations.slice(0, MAX_DIFF_LINES) : operations
  return { lines, truncated: operations.length > MAX_DIFF_LINES }
}

function lcsDiff(left: string[], right: string[]): DiffLine[] {
  const rows = left.length + 1
  const columns = right.length + 1
  const table = new Int32Array(rows * columns)
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * columns + j] =
        left[i] === right[j]
          ? (table[(i + 1) * columns + j + 1] as number) + 1
          : Math.max(table[(i + 1) * columns + j] as number, table[i * columns + j + 1] as number)
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ type: "context", text: left[i] as string })
      i += 1
      j += 1
    } else if ((table[(i + 1) * columns + j] as number) >= (table[i * columns + j + 1] as number)) {
      lines.push({ type: "remove", text: left[i] as string })
      i += 1
    } else {
      lines.push({ type: "add", text: right[j] as string })
      j += 1
    }
  }
  while (i < left.length) {
    lines.push({ type: "remove", text: left[i] as string })
    i += 1
  }
  while (j < right.length) {
    lines.push({ type: "add", text: right[j] as string })
    j += 1
  }
  return lines
}

/** Линейный fallback: общий префикс/суффикс, середина — remove + add. */
function prefixSuffixDiff(left: string[], right: string[]): DiffLine[] {
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1
  let endLeft = left.length - 1
  let endRight = right.length - 1
  while (endLeft >= start && endRight >= start && left[endLeft] === right[endRight]) {
    endLeft -= 1
    endRight -= 1
  }
  return [
    ...left.slice(0, start).map((text): DiffLine => ({ type: "context", text })),
    ...left.slice(start, endLeft + 1).map((text): DiffLine => ({ type: "remove", text })),
    ...right.slice(start, endRight + 1).map((text): DiffLine => ({ type: "add", text })),
    ...left.slice(endLeft + 1).map((text): DiffLine => ({ type: "context", text })),
  ]
}

function jsonText(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value, null, 2)
}

function maskedJsonText(value: unknown, keyHint?: string): string | undefined {
  return jsonText(maskSecrets(value, keyHint))
}

/** Происхождение скилла для сообщения: пин из манифеста или SHA зеркала. */
function skillOrigin(skill: { entry: { source: string; ref?: string }; sourceRef: string }): string {
  if (skill.entry.ref !== undefined) return `${skill.entry.source}@${skill.entry.ref}`
  return /^[0-9a-f]{7,40}$/i.test(skill.sourceRef)
    ? `${skill.entry.source}@${skill.sourceRef.slice(0, 12)}`
    : skill.entry.source
}

function maskLines(lines: DiffLine[]): DiffLine[] {
  return lines.map((line) => ({ ...line, text: maskText(line.text) }))
}

function entryFromJson(
  kind: PlanItem["kind"],
  target: string,
  action: PlanAction,
  before: unknown,
  after: unknown,
  detail?: string,
  keyHint?: string,
): DiffEntry {
  const result = diffText(maskedJsonText(before, keyHint), maskedJsonText(after, keyHint))
  return {
    kind,
    target,
    action,
    ...(detail === undefined ? {} : { detail }),
    lines: maskLines(result.lines),
    ...(result.truncated ? { note: "diff обрезан" } : {}),
  }
}

async function listFiles(root: string, limit = MAX_DIR_FILES): Promise<string[]> {
  const files: string[] = []
  const queue: { dir: string; rel: string }[] = [{ dir: root, rel: "" }]
  while (queue.length > 0 && files.length < limit) {
    const item = queue.shift() as { dir: string; rel: string }
    const entries = await fs.readdir(item.dir, { withFileTypes: true }).catch(() => [])
    for (const child of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) break
      const rel = item.rel === "" ? child.name : `${item.rel}/${child.name}`
      if (child.isDirectory()) queue.push({ dir: path.join(item.dir, child.name), rel })
      else files.push(rel)
    }
  }
  return files
}

/** Файловый diff двух директорий: + только в источнике, − только в цели, ~ изменён. */
async function diffDirs(sourceDir: string, targetDir: string): Promise<DiffLinesResult> {
  const sourceFiles = await listFiles(sourceDir)
  const targetFiles = await listFiles(targetDir)
  const sourceSet = new Set(sourceFiles)
  const targetSet = new Set(targetFiles)
  const lines: DiffLine[] = []

  for (const file of sourceSet) {
    if (!targetSet.has(file)) lines.push({ type: "add", text: file })
  }
  for (const file of targetSet) {
    if (!sourceSet.has(file)) lines.push({ type: "remove", text: file })
  }
  for (const file of sourceSet) {
    if (!targetSet.has(file)) continue
    const from = await fs.readFile(path.join(sourceDir, file)).catch(() => undefined)
    const to = await fs.readFile(path.join(targetDir, file)).catch(() => undefined)
    if (from === undefined || to === undefined) continue
    if (sha256(from) !== sha256(to)) lines.push({ type: "change", text: file })
  }
  return { lines: lines.slice(0, MAX_DIFF_LINES), truncated: lines.length > MAX_DIFF_LINES }
}

async function linkTarget(dir: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(dir)
    return stat.isSymbolicLink() ? fs.readlink(dir) : undefined
  } catch {
    return undefined
  }
}

/** Все изменённые пункты плана с деталями. */
export async function computeDiff(
  input: ScopeInput,
  desired: DesiredState,
  state: HarnessState,
  plan: PlanReport,
): Promise<DiffReport> {
  if (plan.blocked !== undefined) return { entries: [], blocked: plan.blocked }
  const scope = scopeFrom(input)
  const entries: DiffEntry[] = []
  const configText = await readText(MANAGED_CONFIG_FILE(scope))
  const changed = plan.items.filter((item) => item.action !== "unchanged")

  for (const item of changed) {
    if (item.kind === "config") {
      const key = item.target.slice("config:".length)
      const after = item.action === "remove" ? undefined : desired.config[key]
      entries.push(
        entryFromJson("config", item.target, item.action, valueAt(configText, [key]), after, item.detail, key),
      )
      continue
    }
    if (item.kind === "mcp") {
      const name = item.target.slice("mcp:".length)
      const after = item.action === "remove" ? undefined : desired.mcpServers[name]
      entries.push(
        entryFromJson(
          "mcp",
          item.target,
          item.action,
          valueAt(configText, ["mcp", "servers", name]),
          after,
          item.detail,
        ),
      )
      continue
    }
    if (item.kind === "permissions" || item.kind === "policies") {
      const key = item.target
      const after = item.action === "remove" ? undefined : item.kind === "permissions" ? desired.permissions : desired.policies
      entries.push(entryFromJson(item.kind, item.target, item.action, valueAt(configText, [key]), after, item.detail))
      continue
    }
    if (item.kind === "agent") {
      const name = item.target.slice("agent:".length)
      const file = agentFilePath(scope, name)
      const before = await readText(file)
      const definition = desired.agents.find((agent) => agent.name === name)
      const after = item.action === "remove" || definition === undefined ? undefined : definition.content
      const result = diffText(before, after)
      entries.push({
        kind: "agent",
        target: item.target,
        action: item.action,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        lines: maskLines(result.lines),
        ...(result.truncated ? { note: "diff обрезан" } : {}),
      })
      continue
    }
    if (item.kind === "instructions") {
      const name = item.target.slice("instructions:".length)
      const relative = desired.instructions.file
      const previous = state.instructions.file
      const fromPrevious = previous !== "" && previous !== relative && item.detail?.includes("файл сменился") === true
      const file = instructionsFilePath(scope, fromPrevious ? previous : relative)
      const parsed = parseInstructionBlocks((await readText(file)) ?? "")
      const block = desired.instructions.blocks.find((candidate) => candidate.name === name)
      const before = parsed.blocks.get(name)
      const after =
        item.action === "remove" || block === undefined ? undefined : normalizeInstructionContent(block.content)
      const result = diffText(before, after)
      entries.push({
        kind: "instructions",
        target: item.target,
        action: item.action,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        lines: maskLines(result.lines),
        ...(result.truncated ? { note: "diff обрезан" } : {}),
      })
      continue
    }
    if (item.kind === "skill") {
      const installName = item.target.slice("skill:".length)
      const skill = desired.skills.find((candidate) => candidate.installName === installName)
      if (skill === undefined) {
        /* Скилл удаляется: показываем, что уйдёт с диска */
        const dir = path.join(scope.skillsDir, installName)
        const link = await linkTarget(dir)
        if (link !== undefined) {
          entries.push({
            kind: "skill",
            target: item.target,
            action: item.action,
            detail: "reference",
            lines: [{ type: "remove", text: `→ ${link}` }],
          })
        } else if (await isDirectory(dir)) {
          const files = await listFiles(dir)
          entries.push({
            kind: "skill",
            target: item.target,
            action: item.action,
            lines: files.slice(0, MAX_DIFF_LINES).map((file) => ({ type: "remove", text: file })),
            ...(files.length > MAX_DIFF_LINES ? { note: "diff обрезан" } : {}),
          })
        } else {
          entries.push({ kind: "skill", target: item.target, action: item.action, lines: [] })
        }
        continue
      }

      const targetDir = path.join(scope.skillsDir, installName)
      const mode = skill.entry.mode ?? "vendor"
      if (mode === "reference") {
        const current = await linkTarget(targetDir)
        entries.push({
          kind: "skill",
          target: item.target,
          action: item.action,
          detail: "reference",
          lines: [
            ...(current === undefined ? [] : [{ type: "remove" as const, text: `→ ${current}` }]),
            { type: "add" as const, text: `→ ${skill.sourceDir}` },
          ],
        })
        continue
      }
      if (!(await pathExists(targetDir))) {
        const files = await listFiles(skill.sourceDir, 30)
        entries.push({
          kind: "skill",
          target: item.target,
          action: item.action,
          detail: `vendor ← ${skillOrigin(skill)}`,
          lines: files.map((file) => ({ type: "add", text: file })),
          ...(files.length >= 30 ? { note: "показаны первые 30 файлов" } : {}),
        })
        continue
      }
      const result = await diffDirs(skill.sourceDir, targetDir)
      entries.push({
        kind: "skill",
        target: item.target,
        action: item.action,
        detail: `vendor ← ${skillOrigin(skill)}`,
        lines: result.lines,
        ...(result.truncated ? { note: "diff обрезан" } : {}),
      })
    }
  }

  return { entries }
}
