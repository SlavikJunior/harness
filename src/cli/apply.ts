import { Command } from "commander"
import { loadManifest } from "../manifest/load.js"
import { buildCatalog } from "../catalog/index.js"
import { buildDesiredState } from "../apply/desired.js"
import { computePlan } from "../apply/plan.js"
import { applyDesired } from "../apply/apply.js"
import { loadState } from "../apply/state.js"
import { printApplyOutcome } from "./print.js"
import { ok, warn } from "../core/log.js"

/** `harness apply`: применить манифест (--dry-run без записи). */

export const applyCommand = new Command("apply")
  .description("Привести проект к состоянию манифеста")
  .option("--dry-run", "показать план, ничего не менять")
  .option("-r, --refresh", "обновить зеркала источников (git pull) перед применением")
  .action(async (options: { dryRun?: boolean; refresh?: boolean }) => {
    const projectRoot = process.cwd()
    const manifest = await loadManifest(projectRoot)
    const catalog = await buildCatalog({ refresh: options.refresh })
    const desired = buildDesiredState(projectRoot, manifest, catalog)
    const state = await loadState(projectRoot)
    const plan = await computePlan(projectRoot, desired, state)

    if (plan.drift.length > 0) {
      for (const entry of plan.drift) warn(entry)
    }
    const outcome = await applyDesired(projectRoot, desired, plan, { dryRun: options.dryRun })
    printApplyOutcome(outcome)
    if (outcome.dryRun) {
      ok("Это был dry-run. Реальное применение: harness apply")
    }
  })
