import { Command } from "commander"
import { loadManifest } from "../manifest/load.js"
import { buildCatalog } from "../catalog/index.js"
import { buildDesiredState, catalogRefs } from "../apply/desired.js"
import { computePlan } from "../apply/plan.js"
import { loadState } from "../apply/state.js"
import { scanManifest } from "../secrets/scan.js"
import { printPlanReport } from "./print.js"
import { planExitCode, planReportJson } from "./json.js"
import { fail } from "../core/log.js"
import { resolveScope } from "../scope.js"

/** `harness plan`: предпросмотр изменений (dry-run без записи). */

export const planCommand = new Command("plan")
  .description("Показать, что изменит apply: конфиг, скиллы, MCP")
  .option("--json", "вывести план в формате JSON (для CI)")
  .option("--global", "глобальный скоуп: ~/.config/opencode и ~/.config/harness")
  .action(async (options: { json?: boolean; global?: boolean }, command: Command) => {
    const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })
    const manifest = await loadManifest(scope)
    const refs = catalogRefs(manifest)
    const catalog = await buildCatalog({ refs, sourceFilter: Object.keys(refs) })
    const desired = buildDesiredState(scope, manifest, catalog)
    const state = await loadState(scope)
    const plan = await computePlan(scope, desired, state)

    if (options.json === true) {
      console.log(JSON.stringify(planReportJson(plan, scanManifest(manifest)), null, 2))
      process.exitCode = planExitCode(plan)
      return
    }
    if (plan.blocked !== undefined) {
      fail("План заблокирован", plan.blocked)
      process.exitCode = 1
      return
    }
    printPlanReport(plan, scanManifest(manifest), {
      footer:
        scope.kind === "global"
          ? "  Глобальный скоуп · применить: harness --global apply · проверка: harness --global doctor"
          : undefined,
    })
  })
