import { Command } from "commander"
import { loadContext } from "../apply/context.js"
import { computeDiff } from "../apply/diff.js"
import { printDiffReport } from "./print.js"
import { fail } from "../core/log.js"
import { resolveScope } from "../scope.js"

/** `harness diff`: подробный diff текущего состояния и манифеста. */

export const diffCommand = new Command("diff")
  .description("Показать подробный diff: значения конфига, файлы скиллов, агентов и инструкций")
  .option("--json", "вывести diff в формате JSON")
  .option("--global", "глобальный скоуп: ~/.config/opencode и ~/.config/harness")
  .action(async (options: { json?: boolean; global?: boolean }, command: Command) => {
    const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })
    const context = await loadContext(scope)
    const report = await computeDiff(scope, context.desired, context.state, context.plan)

    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2))
      if (report.blocked !== undefined) process.exitCode = 1
      return
    }
    if (report.blocked !== undefined) {
      fail("Diff недоступен", report.blocked)
      process.exitCode = 1
      return
    }
    printDiffReport(report, {
      footer:
        scope.kind === "global"
          ? "  Применить: harness --global apply  ·  откат: harness --global apply --undo"
          : undefined,
    })
  })
