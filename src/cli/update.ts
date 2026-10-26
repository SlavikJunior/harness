import { Command } from "commander"
import { loadContext } from "../apply/context.js"
import { applyDesired } from "../apply/apply.js"
import { scanManifest } from "../secrets/scan.js"
import { printApplyOutcome, printPlanReport } from "./print.js"
import { planReportJson, type UpdateJsonReport } from "./json.js"
import { fail, info, ok } from "../core/log.js"
import { resolveScope, type Scope } from "../scope.js"
import { watchUpdates } from "./watch.js"

/**
 * `harness update`: обновить зеркала источников и применить изменения.
 *
 * Для незапиненных скиллов подтягивается HEAD (git pull --ff-only),
 * для запиненных — fetch указанного ref. Изменения проходят через обычный
 * план: видно, что именно поменяется, и ничего не пишется при --dry-run.
 */

export interface UpdateOptions {
  dryRun?: boolean
  json?: boolean
}

export async function updateOnce(scope: Scope, options: UpdateOptions): Promise<UpdateJsonReport> {
  const { manifest, desired, state, plan } = await loadContext(scope, { refresh: true })

  if (options.json !== true) {
    printPlanReport(plan, scanManifest(manifest), {
      footer:
        scope.kind === "global"
          ? "  Глобальный скоуп · применить: harness --global update · проверка: harness --global doctor"
          : "  Применить: harness update  ·  dry-run: harness update --dry-run  ·  проверка: harness doctor",
    })
  }

  if (plan.blocked !== undefined) {
    return {
      plan: planReportJson(plan, scanManifest(manifest)),
      applied: [],
      dryRun: options.dryRun === true,
    }
  }

  const outcome = await applyDesired(scope, desired, plan, state, { dryRun: options.dryRun })
  if (options.json !== true) {
    printApplyOutcome(outcome, { global: scope.kind === "global" })
    if (outcome.dryRun) {
      ok(
        `Это был dry-run. Реальное обновление: ${
          scope.kind === "global" ? "harness --global update" : "harness update"
        }`,
      )
    }
  }
  return {
    plan: planReportJson(plan, scanManifest(manifest)),
    applied: outcome.applied,
    dryRun: outcome.dryRun,
  }
}

export const updateCommand = new Command("update")
  .description("Обновить зеркала скиллов и применить изменения (apply --refresh)")
  .option("--dry-run", "показать план обновления, ничего не менять")
  .option("--json", "вывести отчёт обновления в формате JSON")
  .option("--watch", "следить за upstream и обновлять при изменениях (Ctrl+C — стоп)")
  .option("--interval <seconds>", "интервал опроса в watch-режиме", "300")
  .option("--global", "глобальный скоуп: ~/.config/opencode и ~/.config/harness")
  .action(
    async (
      options: { dryRun?: boolean; json?: boolean; watch?: boolean; interval?: string; global?: boolean },
      command: Command,
    ) => {
      const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })

      if (options.watch === true) {
        const seconds = Number(options.interval)
        if (!Number.isInteger(seconds) || seconds <= 0) {
          fail(`--interval: ожидалось положительное целое число секунд, получено "${options.interval}"`)
          process.exitCode = 1
          return
        }
        const controller = new AbortController()
        const stop = (): void => {
          info("watch: остановка…")
          controller.abort()
        }
        process.once("SIGINT", stop)
        try {
          await watchUpdates(scope, {
            intervalMs: seconds * 1000,
            json: options.json === true,
            dryRun: options.dryRun,
            signal: controller.signal,
          })
        } finally {
          process.removeListener("SIGINT", stop)
        }
        return
      }

      const report = await updateOnce(scope, { dryRun: options.dryRun, json: options.json })
      if (options.json === true) {
        console.log(JSON.stringify(report, null, 2))
        if (report.plan.blocked !== undefined) process.exitCode = 1
        return
      }
      if (report.plan.blocked !== undefined) {
        fail("Обновление заблокировано", report.plan.blocked)
        process.exitCode = 1
      }
    },
  )
