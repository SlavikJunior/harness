import { Command } from "commander"
import { loadManifest } from "../manifest/load.js"
import { buildCatalog } from "../catalog/index.js"
import { buildDesiredState, catalogRefs } from "../apply/desired.js"
import { computePlan } from "../apply/plan.js"
import { applyDesired } from "../apply/apply.js"
import { loadState } from "../apply/state.js"
import { printApplyOutcome } from "./print.js"
import { ok, warn } from "../core/log.js"
import { resolveScope } from "../scope.js"

/** `harness apply`: применить манифест (--dry-run без записи). */

export const applyCommand = new Command("apply")
  .description("Привести проект к состоянию манифеста")
  .option("--dry-run", "показать план, ничего не менять")
  .option("-r, --refresh", "обновить зеркала источников (git pull) перед применением")
  .option("--global", "глобальный скоуп: ~/.config/opencode и ~/.config/harness")
  .action(async (options: { dryRun?: boolean; refresh?: boolean; global?: boolean }, command: Command) => {
    const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })
    const manifest = await loadManifest(scope)
    const refs = catalogRefs(manifest)
    const catalog = await buildCatalog({
      refresh: options.refresh,
      refs,
      sourceFilter: Object.keys(refs),
    })
    const desired = buildDesiredState(scope, manifest, catalog)
    const state = await loadState(scope)
    const plan = await computePlan(scope, desired, state)

    if (plan.drift.length > 0) {
      for (const entry of plan.drift) warn(entry)
    }
    const outcome = await applyDesired(scope, desired, plan, state, { dryRun: options.dryRun })
    printApplyOutcome(outcome)
    if (outcome.dryRun) {
      ok(
        `Это был dry-run. Реальное применение: ${
          scope.kind === "global" ? "harness --global apply" : "harness apply"
        }`,
      )
    }
  })
