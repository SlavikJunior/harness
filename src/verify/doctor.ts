import { pathExists, readText } from "../core/fs.js"
import { run } from "../core/exec.js"
import { loadManifest } from "../manifest/load.js"
import { MANAGED_CONFIG_FILE } from "../manifest/file.js"
import { buildCatalog } from "../catalog/index.js"
import { buildDesiredState, catalogRefs } from "../apply/desired.js"
import { computePlan } from "../apply/plan.js"
import { loadState } from "../apply/state.js"
import { validateJsoncText, valueAt } from "../apply/config.js"
import { scanManifest } from "../secrets/scan.js"
import { lintPermissions } from "./permissions.js"
import { lintPolicies } from "./policies.js"
import { permissionsSchema, policiesSchema } from "../manifest/schema.js"
import {
  extractInstructionPaths,
  instructionsFilePath,
  parseInstructionBlocks,
} from "../apply/instructions.js"
import { findNodeAtLocation, parseTree, type JSONPath } from "jsonc-parser"
import path from "node:path"
import { displayPath, scopeFrom, type ScopeInput } from "../scope.js"

/** `harness doctor`: фактическое состояние проекта против манифеста. */

export type CheckLevel = "ok" | "warn" | "error"

export interface DoctorCheck {
  level: CheckLevel
  message: string
}

export async function runDoctor(input: ScopeInput, options: { live?: boolean } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const scope = scopeFrom(input)
  const push = (level: CheckLevel, message: string): void => {
    checks.push({ level, message })
  }

  /* Манифест */
  let manifest
  try {
    manifest = await loadManifest(scope)
  } catch (error) {
    push("error", error instanceof Error ? error.message : String(error))
    return checks
  }
  push("ok", `манифест валиден (version: ${manifest.version})`)

  /* Плейнтекст-секреты: манифест коммитится — значения не печатаем */
  const secrets = scanManifest(manifest)
  if (secrets.length === 0) {
    push("ok", "плейнтекст-секретов в манифесте нет")
  } else {
    for (const finding of secrets) {
      push("warn", `секрет: ${finding.path} — ${finding.reason} (замени на {env:VAR})`)
    }
  }

  /* Каталог + разрешение скиллов */
  let desired
  try {
    const refs = catalogRefs(manifest)
    const catalog = await buildCatalog({ refs, sourceFilter: Object.keys(refs) })
    desired = buildDesiredState(scope, manifest, catalog)
    if (desired.skills.length > 0) {
      push("ok", `скиллы разрешены: ${desired.skills.map((skill) => skill.installName).join(", ")}`)
    }
  } catch (error) {
    push("error", error instanceof Error ? error.message : String(error))
    return checks
  }

  /* Глобальный скоуп: артефакты живут в конфиге пользователя */
  if (scope.kind === "global") {
    push("ok", `глобальный скоуп: ${displayPath(scope, scope.configFile)}`)
    if ((desired.permissions?.length ?? 0) > 0 || (desired.policies?.length ?? 0) > 0) {
      push(
        "warn",
        "глобальные permissions/policies перекрывают проектные: проектный allow не отменит глобальный ask/deny",
      )
    }
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
  const managedFile = MANAGED_CONFIG_FILE(scope)
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
      /* Форма фактического массива: ручная правка managed-файла не должна проходить молча */
      const actualPermissions = valueAt(text, ["permissions"])
      if (actualPermissions !== undefined) {
        const parsedRules = permissionsSchema.safeParse(actualPermissions)
        if (!parsedRules.success) {
          const issue = parsedRules.error.issues[0]
          const where = issue !== undefined && issue.path.length > 0 ? `[${issue.path.join(".")}]` : ""
          push("error", `permissions${where}: ${issue?.message ?? "некорректное правило"}`)
        }
      }
      const actualPolicies = valueAt(text, ["policies"])
      if (actualPolicies !== undefined) {
        const parsedRules = policiesSchema.safeParse(actualPolicies)
        if (!parsedRules.success) {
          const issue = parsedRules.error.issues[0]
          const where = issue !== undefined && issue.path.length > 0 ? `[${issue.path.join(".")}]` : ""
          push("error", `policies${where}: ${issue?.message ?? "некорректная политика"}`)
        }
      }
    }
  }

  /* Permissions: линты манифеста (V2 по умолчанию разрешает всё) */
  if (desired.permissions !== undefined) {
    if (desired.permissions.length === 0) {
      push("ok", "permissions: пустой список — правила V2 не переопределяются")
    } else {
      push("ok", `permissions: задано правил — ${desired.permissions.length}`)
    }
    for (const lint of lintPermissions(desired.permissions)) push("warn", lint.message)
  }

  /* Policies: линты ширины запретов */
  if (desired.policies !== undefined) {
    if (desired.policies.length === 0) {
      push("ok", "policies: пустой список — жёстких запретов нет")
    } else {
      push("ok", `policies: задано запретов — ${desired.policies.length}`)
    }
    for (const lint of lintPolicies(desired.policies)) push("warn", lint.message)
  }

  /* Агенты: файлы должны существовать; содержимое сверяет обычный план */
  for (const agent of desired.agents) {
    if (await pathExists(agent.file)) {
      push("ok", `агент ${agent.name}: ${agent.relativePath}`)
    } else {
      push("warn", `агент ${agent.name}: ${agent.relativePath} не создан — запусти harness apply`)
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

  /* Инструкции: маркеры блоков и пути/команды из inline-code */
  if (desired.instructions.blocks.length > 0) {
    const relative = desired.instructions.file
    const instructionText = await readText(instructionsFilePath(scope, relative))
    const parsed = parseInstructionBlocks(instructionText ?? "")
    if (parsed.errors.length > 0) {
      for (const error of parsed.errors) push("error", `${relative}: ${error}`)
    } else if (instructionText === undefined) {
      push("warn", `${relative} не создан — запусти harness apply`)
    }
    for (const entry of extractInstructionPaths(desired.instructions.blocks)) {
      if (await pathExists(path.resolve(scope.instructionsBase, entry))) {
        push("ok", `инструкции: путь "${entry}" существует`)
      } else {
        push("warn", `инструкции: путь "${entry}" не найден в проекте`)
      }
    }
  }

  /* Соответствие манифесту на живом state */
  let state
  try {
    state = await loadState(scope)
  } catch (error) {
    push("error", error instanceof Error ? error.message : String(error))
    return checks
  }
  if (state.appliedAt === "") {
    push("warn", "harness apply не выполнялся — состояние не применено")
  }

  const plan = await computePlan(scope, desired, state)
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
