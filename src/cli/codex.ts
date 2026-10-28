import { Command } from "commander"
import { HarnessError } from "../core/errors.js"
import { fail } from "../core/log.js"
import { resolveScope, type Scope } from "../scope.js"
import { exportCodex } from "../targets/codex/export.js"
import { codexPaths, displayHomePath } from "../targets/codex/paths.js"
import { restoreCodexBackup } from "../targets/codex/backup.js"
import { printCodexRestore, printCodexResults } from "../targets/codex/report.js"
import { codexStrictFailure, type CodexExportResult } from "../targets/codex/types.js"

/** `harness codex`: перенос OpenCode-харнесса в Codex (односторонний экспорт). */

interface ExportOptions {
  global?: boolean
  all?: boolean
  dryRun?: boolean
  json?: boolean
  strict?: boolean
  force?: boolean
  manifestOnly?: boolean
  allowMcpSecretArgs?: boolean
}

function validateScopeOptions(options: { global?: boolean; all?: boolean }): void {
  if (options.global === true && options.all === true) {
    throw new HarnessError("--global и --all взаимоисключающие", "выбери один скоуп или --all")
  }
}

async function scopesFor(cwd: string, options: { global?: boolean; all?: boolean }): Promise<Scope[]> {
  validateScopeOptions(options)
  if (options.all === true) {
    return [await resolveScope(cwd), await resolveScope(cwd, { global: true })]
  }
  return [await resolveScope(cwd, { global: options.global === true })]
}

function errorResult(scope: Scope, error: unknown): CodexExportResult {
  const paths = codexPaths(scope)
  return {
    scope: scope.kind,
    codexHome: displayHomePath(paths.codexHome),
    dryRun: false,
    items: [],
    written: [],
    removed: [],
    errors: [error instanceof Error ? error.message : String(error)],
  }
}

export const codexCommand = new Command("codex").description("Перенос OpenCode-харнесса в Codex")

codexCommand
  .command("export")
  .description("Сгенерировать Codex config/agents/skills/instructions из OpenCode/harness")
  .option("--global", "глобальный Codex (~/.codex, ~/.agents/skills)")
  .option("--all", "project и global")
  .option("--dry-run", "показать отчёт, ничего не менять")
  .option("--json", "машиночитаемый отчёт")
  .option("--strict", "exit 1 при approximate/skipped/conflict")
  .option("--force", "перезаписать чужие/изменённые Codex-артефакты (с backup)")
  .option("--manifest-only", "не добавлять артефакты, которых нет в harness.yaml")
  .option(
    "--allow-mcp-secret-args",
    "разрешить sh -c-обёртку для MCP с секретами в аргументах (литеральные секреты попадут в config.toml)",
  )
  .action(async (options: ExportOptions, command: Command) => {
    const global = command.optsWithGlobals().global === true
    const cwd = process.cwd()
    let scopes: Scope[] = []
    try {
      scopes = await scopesFor(cwd, {
        ...(global ? { global: true } : {}),
        ...(options.all === true ? { all: true } : {}),
      })
    } catch (error) {
      if (error instanceof HarnessError) fail(error.message, error.hint)
      else fail(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
      return
    }

    const results: CodexExportResult[] = []
    for (const scope of scopes) {
      try {
        results.push(
          await exportCodex(scope, {
            ...(options.dryRun === true ? { dryRun: true } : {}),
            ...(options.force === true ? { force: true } : {}),
            ...(options.manifestOnly === true ? { manifestOnly: true } : {}),
            ...(options.allowMcpSecretArgs === true ? { allowMcpSecretArgs: true } : {}),
          }),
        )
      } catch (error) {
        results.push(errorResult(scope, error))
      }
    }

    if (options.json === true) {
      console.log(JSON.stringify({ results }, null, 2))
    } else {
      printCodexResults(results)
    }
    const failed = results.some(
      (result) => result.errors.length > 0 || (options.strict === true && codexStrictFailure(result)),
    )
    if (failed) process.exitCode = 1
  })

codexCommand
  .command("undo")
  .description("Откатить последний Codex export из снапшота")
  .option("--global", "глобальный Codex")
  .option("--all", "project и global")
  .option("--dry-run", "показать, что будет восстановлено")
  .option("--json", "машиночитаемый результат")
  .action(async (options: { global?: boolean; all?: boolean; dryRun?: boolean; json?: boolean }, command: Command) => {
    const global = command.optsWithGlobals().global === true
    let scopes: Scope[] = []
    try {
      scopes = await scopesFor(process.cwd(), {
        ...(global ? { global: true } : {}),
        ...(options.all === true ? { all: true } : {}),
      })
    } catch (error) {
      if (error instanceof HarnessError) fail(error.message, error.hint)
      else fail(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
      return
    }

    const outcomes = []
    let failed = false
    for (const scope of scopes) {
      try {
        const paths = codexPaths(scope)
        const outcome = await restoreCodexBackup(scope, paths.backupsDir, {
          ...(options.dryRun === true ? { dryRun: true } : {}),
        })
        outcomes.push({ scope: scope.kind, ...outcome })
        if (options.json !== true) printCodexRestore(outcome)
      } catch (error) {
        failed = true
        if (options.json !== true) {
          if (error instanceof HarnessError) fail(error.message, error.hint)
          else fail(error instanceof Error ? error.message : String(error))
        } else {
          outcomes.push({
            scope: scope.kind,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    if (options.json === true) console.log(JSON.stringify({ results: outcomes }, null, 2))
    if (failed) process.exitCode = 1
  })
