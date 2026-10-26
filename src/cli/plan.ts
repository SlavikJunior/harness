import { Command } from "commander"
import { loadContext } from "../apply/context.js"
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
    const { manifest, plan } = await loadContext(scope)

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
