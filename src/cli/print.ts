import pc from "picocolors"
import type { PlanReport } from "../apply/types.js"
import type { ApplyOutcome } from "../apply/apply.js"
import type { RestoreOutcome } from "../apply/backup.js"
import type { DiffReport } from "../apply/diff.js"
import type { AutoFixResult } from "../verify/fix.js"
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

export interface PlanPrintOptions {
  /** подсказка внизу отчёта: у plan и update следующий шаг разный */
  footer?: string
}

export function printPlanReport(
  report: PlanReport,
  secrets: SecretFinding[] = [],
  options: PlanPrintOptions = {},
): void {
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
  console.log(
    pc.dim(options.footer ?? "  Применить: harness apply  ·  dry-run: harness plan  ·  проверка: harness doctor"),
  )
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

export function printApplyOutcome(outcome: ApplyOutcome, options: { global?: boolean } = {}): void {
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
  console.log(`${pc.green("✔")} применено пунктов: ${outcome.applied.length} · state: ${outcome.stateFile}`)
  if (outcome.backupDir !== undefined) {
    const prefix = options.global === true ? "harness --global" : "harness"
    console.log(pc.dim(`  ↩ откат последнего изменения: ${prefix} apply --undo (${outcome.backupDir})`))
  }
}

export interface DiffPrintOptions {
  footer?: string
}

export function printRestoreOutcome(outcome: RestoreOutcome): void {
  console.log("")
  console.log(pc.bold(outcome.dryRun ? "Откат (dry-run)" : "Откат последнего apply"))
  console.log(pc.dim(`  снапшот: ${outcome.displayDir}`))
  for (const action of outcome.actions) {
    const glyph = action.action === "restore" ? pc.green("↩") : pc.red("-")
    const verb = action.action === "restore" ? "восстановить" : "удалить"
    console.log(`  ${glyph} ${action.display} ${pc.dim(`— ${verb}`)}`)
  }
  console.log("")
  console.log(
    `${pc.green("✔")} восстановлено: ${outcome.restored}, удалено: ${outcome.removed}` +
      (outcome.dryRun ? "" : " · снапшот израсходован"),
  )
}

function diffLine(line: { type: string; text: string }): string {
  switch (line.type) {
    case "add":
      return `  ${pc.green("+")} ${line.text}`
    case "remove":
      return `  ${pc.red("-")} ${line.text}`
    case "change":
      return `  ${pc.blue("~")} ${line.text}`
    default:
      return `    ${pc.dim(line.text)}`
  }
}

/** Diff по категориям: заголовок цели + строки +/-/~. */
export function printDiffReport(report: DiffReport, options: DiffPrintOptions = {}): void {
  console.log("")
  console.log(pc.bold("Diff — текущее состояние → манифест"))
  if (report.entries.length === 0) {
    console.log(pc.dim("  всё соответствует манифесту"))
    console.log("")
    return
  }
  for (const entry of report.entries) {
    const detail = entry.detail === undefined ? "" : pc.dim(`  ${entry.detail}`)
    console.log(`  ${pc.bold(entry.target)}${detail}`)
    for (const line of entry.lines) console.log(diffLine(line))
    if (entry.note !== undefined) console.log(`  ${pc.yellow("⚠")} ${entry.note}`)
  }
  console.log("")
  console.log(pc.dim(options.footer ?? "  Применить: harness apply  ·  откат: harness apply --undo"))
}

export function printAutoFixOutcome(result: AutoFixResult): void {
  console.log("")
  console.log(pc.bold("Автоисправление"))
  if (result.fixed.length === 0 && result.skipped.length === 0) {
    console.log(pc.dim("  нечего исправлять"))
    return
  }
  for (const item of result.fixed) console.log(line(item))
  if (result.fixed.length > 0) {
    console.log(`${pc.green("✔")} исправлено пунктов: ${result.fixed.length}`)
  }
  for (const reason of result.skipped) console.log(`  ${pc.yellow("⚠")} ${reason}`)
  if (result.skipped.length > 0) {
    console.log(pc.dim("  Исправь вручную и примени осознанно: harness apply"))
  }
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
