import { Command } from "commander"
import { loadManifest } from "../manifest/load.js"
import { buildCatalog } from "../catalog/index.js"
import { buildDesiredState, catalogRefs } from "../apply/desired.js"
import { computePlan } from "../apply/plan.js"
import { applyDesired } from "../apply/apply.js"
import { loadState } from "../apply/state.js"
import { scanManifest } from "../secrets/scan.js"
import { printApplyOutcome, printPlanReport } from "./print.js"
import { fail, ok } from "../core/log.js"

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
  .action(async (options: { dryRun?: boolean }) => {
    const projectRoot = process.cwd()
    const manifest = await loadManifest(projectRoot)
    const refs = catalogRefs(manifest)
    const catalog = await buildCatalog({ refresh: true, refs, sourceFilter: Object.keys(refs) })
    const desired = buildDesiredState(projectRoot, manifest, catalog)
    const state = await loadState(projectRoot)
    const plan = await computePlan(projectRoot, desired, state)

    if (plan.blocked !== undefined) {
      fail("Обновление заблокировано", plan.blocked)
      process.exitCode = 1
      return
    }
    printPlanReport(plan, scanManifest(manifest), {
      footer: "  Применить: harness update  ·  dry-run: harness update --dry-run  ·  проверка: harness doctor",
    })

    const outcome = await applyDesired(projectRoot, desired, plan, state, { dryRun: options.dryRun })
    printApplyOutcome(outcome)
    if (outcome.dryRun) ok("Это был dry-run. Реальное обновление: harness update")
  })
