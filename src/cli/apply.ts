import { Command } from "commander"
import { loadContext } from "../apply/context.js"
import { applyDesired } from "../apply/apply.js"
import { restoreBackup } from "../apply/backup.js"
import { printApplyOutcome, printRestoreOutcome } from "./print.js"
import { ok, warn } from "../core/log.js"
import { resolveScope } from "../scope.js"

/** `harness apply`: применить манифест (--dry-run без записи, --undo — откат). */

export const applyCommand = new Command("apply")
  .description("Привести проект к состоянию манифеста")
  .option("--dry-run", "показать план, ничего не менять")
  .option("-r, --refresh", "обновить зеркала источников (git pull) перед применением")
  .option("--undo", "откатить последний apply из снапшота .harness/backups")
  .option("--global", "глобальный скоуп: ~/.config/opencode и ~/.config/harness")
  .action(async (options: { dryRun?: boolean; refresh?: boolean; undo?: boolean; global?: boolean }, command: Command) => {
    const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })

    /* Откат не читает манифест: он должен работать, даже если манифест сломан */
    if (options.undo === true) {
      const outcome = await restoreBackup(scope, { dryRun: options.dryRun })
      printRestoreOutcome(outcome)
      if (outcome.dryRun) {
        ok(
          `Это был dry-run. Реальный откат: ${
            scope.kind === "global" ? "harness --global apply --undo" : "harness apply --undo"
          }`,
        )
      }
      return
    }

    const { desired, plan, state } = await loadContext(scope, { refresh: options.refresh })
    if (plan.drift.length > 0) {
      for (const entry of plan.drift) warn(entry)
    }
    const outcome = await applyDesired(scope, desired, plan, state, { dryRun: options.dryRun })
    printApplyOutcome(outcome, { global: scope.kind === "global" })
    if (outcome.dryRun) {
      ok(
        `Это был dry-run. Реальное применение: ${
          scope.kind === "global" ? "harness --global apply" : "harness apply"
        }`,
      )
    }
  })
