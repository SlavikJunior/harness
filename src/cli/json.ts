import type { PlanReport } from "../apply/types.js"
import type { SecretFinding } from "../secrets/scan.js"
import type { DoctorCheck } from "../verify/doctor.js"

/**
 * Машиночитаемые отчёты для CI.
 *
 * `plan --json` — тот же план, что видит человек, но без ANSI и с summary.
 * Значения секретов не попадают ни в план (детали уже замаскированы), ни
 * в findings (только путь и причина).
 */

export interface PlanSummary {
  create: number
  update: number
  remove: number
  unchanged: number
}

export interface PlanJsonReport {
  items: PlanReport["items"]
  summary: PlanSummary
  drift: string[]
  conflicts: string[]
  /** присутствует, только если apply небезопасен */
  blocked?: string
  secrets: Pick<SecretFinding, "path" | "kind" | "reason">[]
}

export function planSummary(report: PlanReport): PlanSummary {
  const summary: PlanSummary = { create: 0, update: 0, remove: 0, unchanged: 0 }
  for (const item of report.items) summary[item.action] += 1
  return summary
}

export function planReportJson(
  report: PlanReport,
  secrets: readonly SecretFinding[] = [],
): PlanJsonReport {
  return {
    items: report.items,
    summary: planSummary(report),
    drift: report.drift,
    conflicts: report.conflicts,
    ...(report.blocked === undefined ? {} : { blocked: report.blocked }),
    secrets: secrets.map(({ path, kind, reason }) => ({ path, kind, reason })),
  }
}

/** Отчёт `harness update --json`: план обновления + реально применённые пункты. */
export interface UpdateJsonReport {
  plan: PlanJsonReport
  applied: PlanReport["items"]
  dryRun: boolean
}

/** Код выхода plan: заблокированный план — ошибка (apply всё равно не пройдёт). */
export function planExitCode(report: PlanReport): 0 | 1 {
  return report.blocked === undefined ? 0 : 1
}

/** Код выхода doctor: ошибки — всегда 1; со strict предупреждения тоже. */
export function doctorExitCode(checks: readonly DoctorCheck[], options: { strict?: boolean } = {}): 0 | 1 {
  const hasError = checks.some((check) => check.level === "error")
  const hasWarn = checks.some((check) => check.level === "warn")
  if (hasError) return 1
  if (options.strict === true && hasWarn) return 1
  return 0
}
