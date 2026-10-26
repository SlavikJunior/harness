import pc from "picocolors"
import type { PlanReport } from "../apply/types.js"
import type { ApplyOutcome } from "../apply/apply.js"
import type { DoctorCheck } from "../verify/doctor.js"
import type { SecretFinding } from "../secrets/scan.js"

/** Печать отчётов CLI. Чистые функции поверх console. */

const ACTION_GLYPH: Record<string, string> = {
  create: pc.green("+"),
  update: pc.blue("~"),
  remove: pc.red("-"),
  unchanged: pc.dim("="),
}

function line(item: { action: string; target: string; detail?: string; warn?: string }): string {
  const unchanged = item.action === "unchanged"
  const glyph = ACTION_GLYPH[item.action] ?? "?"
  const detail = item.detail !== undefined ? pc.dim(`  ${item.detail}`) : ""
  const warn = item.warn !== undefined ? pc.yellow(`  ⚠ ${item.warn}`) : ""
  const target = unchanged ? pc.dim(item.target) : item.target
  return `  ${glyph} ${target}${detail}${warn}`
}

export function printPlanReport(report: PlanReport, secrets: SecretFinding[] = []): void {
  console.log("")
  console.log(pc.bold("План изменений"))
  const changed = report.items.filter((item) => item.action !== "unchanged")
  if (report.items.length === 0) {
    console.log(pc.dim("  (пусто — ничего не прописано в манифесте)"))
  } else if (changed.length === 0) {
    console.log(pc.dim("  всё соответствует манифесту"))
  }
  for (const item of changed) console.log(line(item))

  if (report.blocked !== undefined) {
    console.log("")
    console.log(pc.red(`✖ Заблокировано: ${report.blocked}`))
  }
  if (report.drift.length > 0) {
    console.log("")
    console.log(pc.bold("Drift — правки артефактов вне harness"))
    for (const entry of report.drift) console.log(`  ${pc.yellow("⚠")} ${entry}`)
  }
  if (report.conflicts.length > 0) {
    console.log("")
    console.log(pc.bold("Перекрытия пользовательских конфигов"))
    for (const entry of report.conflicts) console.log(`  ${pc.yellow("⚠")} ${entry}`)
  }
  printSecretFindings(secrets)
  console.log("")
  console.log(pc.dim("  Применить: harness apply  ·  dry-run: harness plan  ·  проверка: harness doctor"))
}

/** Плейнтекст-секреты в манифесте: значения не печатаются — только путь и причина. */
export function printSecretFindings(findings: SecretFinding[]): void {
  if (findings.length === 0) return
  console.log("")
  console.log(pc.bold("Секреты в манифесте — не коммить плейнтекст"))
  for (const finding of findings) {
    console.log(`  ${pc.yellow("⚠")} ${finding.path} ${pc.dim(`— ${finding.reason}`)}`)
  }
  console.log(pc.dim("  → вынеси значение в env и используй {env:VAR}: V2 подставляет его до парсинга конфига"))
}

export function printApplyOutcome(outcome: ApplyOutcome): void {
  if (outcome.dryRun) {
    console.log(`${pc.green("✔")} dry-run — записей нет`)
    return
  }
  if (outcome.applied.length === 0) {
    console.log(`${pc.green("✔")} без изменений`)
    return
  }
  console.log("")
  for (const item of outcome.applied) console.log(line(item))
  console.log(`${pc.green("✔")} применено пунктов: ${outcome.applied.length} · state: .harness/state.json`)
}

export function printDoctorChecks(checks: DoctorCheck[]): void {
  console.log("")
  console.log(pc.bold("Проверки"))
  for (const check of checks) {
    const glyph = check.level === "ok" ? pc.green("✔") : check.level === "warn" ? pc.yellow("⚠") : pc.red("✖")
    console.log(`  ${glyph} ${check.message}`)
  }
  const errors = checks.filter((check) => check.level === "error").length
  const warns = checks.filter((check) => check.level === "warn").length
  console.log("")
  console.log(
    errors > 0
      ? pc.red(`✖ ошибок: ${errors}, предупреждений: ${warns}`)
      : warns > 0
        ? pc.yellow(`⚠ ошибок нет, предупреждений: ${warns}`)
        : `${pc.green("✔")} всё чисто`,
  )
}
