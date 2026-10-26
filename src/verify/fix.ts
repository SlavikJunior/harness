import { loadContext } from "../apply/context.js"
import { applyDesired } from "../apply/apply.js"
import type { PlanItem, PlanReport } from "../apply/types.js"
import type { HarnessState } from "../apply/state.js"
import type { ScopeInput } from "../scope.js"

/**
 * `doctor --fix`: автоисправление только безопасных расхождений.
 *
 * Безопасно — создать отсутствующее и убрать то, чем harness владеет по
 * state. Всё, что похоже на ручную правку (`update` с warn) или на чужой
 * ключ конфига, не трогается: для этого нужен осознанный `harness apply`.
 * Изменения, вызванные только удалением артефакта, безопасны — это restore.
 */

export interface AutoFixResult {
  fixed: PlanItem[]
  /** причины, по которым автоисправление не выполнялось */
  skipped: string[]
  stateFile?: string
  backupDir?: string
}

/** Причины, из-за которых план нельзя применять автоматически. */
export function unsafeReasons(plan: PlanReport, state: HarnessState): string[] {
  if (plan.blocked !== undefined) return [plan.blocked]
  const reasons: string[] = []
  for (const item of plan.items) {
    if (item.action === "unchanged") continue
    if (item.warn !== undefined) {
      /* create с warn — восстановление удалённого артефакта, это безопасно */
      if (item.action === "update") {
        reasons.push(`${item.target}: ${item.warn} — нужен явный apply`)
      }
      continue
    }
    if (item.kind === "config" && item.action === "update") {
      const key = item.target.slice("config:".length)
      if (state.configKeys[key] === undefined) {
        reasons.push(`${item.target}: ключ задан вне harness — нужен явный apply`)
      }
    }
    if (item.kind === "mcp" && item.action === "update") {
      const name = item.target.slice("mcp:".length)
      if (state.mcp[name] === undefined) {
        reasons.push(`${item.target}: сервер задан вне harness — нужен явный apply`)
      }
    }
  }
  return [...new Set(reasons)]
}

export async function autoFix(input: ScopeInput): Promise<AutoFixResult> {
  const { scope, desired, plan, state } = await loadContext(input)
  const skipped = unsafeReasons(plan, state)
  if (skipped.length > 0) return { fixed: [], skipped }
  if (plan.items.every((item) => item.action === "unchanged")) return { fixed: [], skipped: [] }

  const outcome = await applyDesired(scope, desired, plan, state)
  return {
    fixed: outcome.applied,
    skipped: [],
    stateFile: outcome.stateFile,
    ...(outcome.backupDir === undefined ? {} : { backupDir: outcome.backupDir }),
  }
}
