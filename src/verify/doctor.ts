import { pathExists, readText } from "../core/fs.js"
import { run } from "../core/exec.js"
import { loadManifest } from "../manifest/load.js"
import { MANAGED_CONFIG_FILE } from "../manifest/file.js"
import { buildCatalog } from "../catalog/index.js"
import { buildDesiredState } from "../apply/desired.js"
import { computePlan } from "../apply/plan.js"
import { loadState } from "../apply/state.js"
import { validateJsoncText } from "../apply/config.js"
import { findNodeAtLocation, parseTree, type JSONPath } from "jsonc-parser"

/** `harness doctor`: фактическое состояние проекта против манифеста. */

export type CheckLevel = "ok" | "warn" | "error"

export interface DoctorCheck {
  level: CheckLevel
  message: string
}

export async function runDoctor(projectRoot: string, options: { live?: boolean } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const push = (level: CheckLevel, message: string): void => {
    checks.push({ level, message })
  }

  /* Манифест */
  let manifest
  try {
    manifest = await loadManifest(projectRoot)
  } catch (error) {
    push("error", error instanceof Error ? error.message : String(error))
    return checks
  }
  push("ok", `манифест валиден (version: ${manifest.version})`)

  /* Каталог + разрешение скиллов */
  let desired
  try {
    const catalog = await buildCatalog({})
    desired = buildDesiredState(projectRoot, manifest, catalog)
    if (desired.skills.length > 0) {
      push("ok", `скиллы разрешены: ${desired.skills.map((skill) => skill.installName).join(", ")}`)
    }
  } catch (error) {
    push("error", error instanceof Error ? error.message : String(error))
    return checks
  }

  /* Зеркала reference-скиллов существуют */
  for (const skill of desired.skills) {
    if ((skill.entry.mode ?? "vendor") !== "reference") continue
    if (await pathExists(skill.sourceDir)) {
      push("ok", "зеркало reference-скилла доступно")
    } else {
      push("error", `зеркало недоступно для ${skill.installName}: ${skill.sourceDir}`)
    }
  }

  /* Управляемый конфиг */
  const managedFile = MANAGED_CONFIG_FILE(projectRoot)
  const text = await readText(managedFile)
  if (text === undefined) {
    push("warn", `${managedFile} не создан — запусти harness apply`)
  } else {
    const syntax = validateJsoncText(text)
    if (syntax !== undefined) {
      push("error", `${managedFile}: ${syntax}`)
    } else {
      push("ok", `${managedFile} валиден`)
      const tree = parseTree(text)
      const schemaNode = findNodeAtLocation(tree as never, ["$schema"] as JSONPath)
      if (schemaNode === undefined) {
        push("warn", "нет $schema — добавится при следующем harness apply")
      }
    }
  }

  /* Бинарники локальных MCP-серверов */
  for (const [name, server] of Object.entries(desired.mcpServers)) {
    if (server.type !== "local") continue
    const binary = server.command[0] as string | undefined
    if (binary === undefined) continue
    const result = await run("which", [binary])
    if (result.code === 0) push("ok", `mcp ${name}: бинарник "${binary}" найден`)
    else push("warn", `mcp ${name}: бинарник "${binary}" не найден в PATH`)
  }

  /* Соответствие манифесту на живом state */
  let state
  try {
    state = await loadState(projectRoot)
  } catch (error) {
    push("error", error instanceof Error ? error.message : String(error))
    return checks
  }
  if (state.appliedAt === "") {
    push("warn", "harness apply не выполнялся — состояние не применено")
  }

  const plan = await computePlan(projectRoot, desired, state)
  if (plan.blocked !== undefined) push("error", plan.blocked)

  const pending = plan.items.filter((item) => item.action !== "unchanged")
  const actionLabel: Record<string, string> = { create: "не создано", update: "не сходится", remove: "не удалено" }
  for (const item of pending) {
    push("warn", `${item.target} — ${actionLabel[item.action] ?? item.action}${item.detail !== undefined ? ` (${item.detail})` : ""}`)
  }
  for (const entry of plan.drift) push("warn", `drift: ${entry}`)
  for (const entry of plan.conflicts) push("warn", `перекрытие: ${entry}`)

  if (pending.length === 0 && plan.blocked === undefined && plan.drift.length === 0) {
    push("ok", "проект соответствует манифесту")
  } else if (pending.length > 0) {
    push("warn", "расхождение с манифестом — запусти harness apply")
  }

  /* Live-проверка реальным CLI */
  if (options.live === true) {
    const version = await run("opencode", ["--version"])
    if (version.code === 0) push("ok", `opencode: ${version.stdout.trim()}`)
    else push("warn", `opencode --version недоступен: ${version.stderr.trim()}`)
    const mcpList = await run("opencode", ["mcp", "list"])
    const tail = mcpList.stdout.trim().split("\n").slice(-3).join("; ")
    if (mcpList.code === 0) push("ok", `opencode mcp list: ${tail === "" ? "(пусто)" : tail}`)
    else push("warn", `opencode mcp list: ${mcpList.stderr.trim()}`)
  }

  return checks
}
