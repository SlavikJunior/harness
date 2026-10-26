import { Command } from "commander"
import { loadManifest } from "../manifest/load.js"
import { buildCatalog } from "../catalog/index.js"
import { buildDesiredState, catalogRefs } from "../apply/desired.js"
import { computePlan } from "../apply/plan.js"
import { applyDesired } from "../apply/apply.js"
import { loadState } from "../apply/state.js"
import { scanManifest } from "../secrets/scan.js"
import { printApplyOutcome, printPlanReport } from "./print.js"
import { planReportJson, type UpdateJsonReport } from "./json.js"
import { fail, ok } from "../core/log.js"
import { resolveScope } from "../scope.js"

/**
 * `harness update`: обновить зеркала источников и применить изменения.
 *
 * Для незапиненных скиллов подтягивается HEAD (git pull --ff-only),
 * для запиненных — fetch указанного ref. Изменения проходят через обычный
 * план: видно, что именно поменяется, и ничего не пишется при --dry-run.
 */

export const updateCommand = new Command("update")
  .description("Обновить зеркала скиллов и применить изменения (apply --refresh)")
  .option("--dry-run", "показать план обновления, ничего не менять")
  .option("--json", "вывести отчёт обновления в формате JSON")
  .option("--global", "глобальный скоуп: ~/.config/opencode и ~/.config/harness")
  .action(async (options: { dryRun?: boolean; json?: boolean; global?: boolean }, command: Command) => {
    const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })
    const manifest = await loadManifest(scope)
    const refs = catalogRefs(manifest)
    const catalog = await buildCatalog({ refresh: true, refs, sourceFilter: Object.keys(refs) })
    const desired = buildDesiredState(scope, manifest, catalog)
    const state = await loadState(scope)
    const plan = await computePlan(scope, desired, state)

    if (plan.blocked !== undefined) {
      if (options.json === true) {
        const blockedReport: UpdateJsonReport = {
          plan: planReportJson(plan, scanManifest(manifest)),
          applied: [],
          dryRun: options.dryRun === true,
        }
        console.log(JSON.stringify(blockedReport, null, 2))
      } else {
        fail("Обновление заблокировано", plan.blocked)
      }
      process.exitCode = 1
      return
    }
    if (options.json !== true) {
      printPlanReport(plan, scanManifest(manifest), {
        footer:
          scope.kind === "global"
            ? "  Глобальный скоуп · применить: harness --global update · проверка: harness --global doctor"
            : "  Применить: harness update  ·  dry-run: harness update --dry-run  ·  проверка: harness doctor",
      })
    }

    const outcome = await applyDesired(scope, desired, plan, state, { dryRun: options.dryRun })
    if (options.json === true) {
      const report: UpdateJsonReport = {
        plan: planReportJson(plan, scanManifest(manifest)),
        applied: outcome.applied,
        dryRun: outcome.dryRun,
      }
      console.log(JSON.stringify(report, null, 2))
      return
    }
    printApplyOutcome(outcome)
    if (outcome.dryRun) {
      ok(
        `Это был dry-run. Реальное обновление: ${
          scope.kind === "global" ? "harness --global update" : "harness update"
        }`,
      )
    }
  })
