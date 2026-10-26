import { Command } from "commander"
import { runDoctor, type DoctorCheck } from "../verify/doctor.js"
import { autoFix, type AutoFixResult } from "../verify/fix.js"
import { printAutoFixOutcome, printDoctorChecks } from "./print.js"
import { doctorExitCode } from "./json.js"
import { resolveScope } from "../scope.js"

/** `harness doctor`: проверка фактического состояния. */

export const doctorCommand = new Command("doctor")
  .description("Проверить состояние харнесса против манифеста")
  .option("--live", "дополнительно прогнать opencode --version и opencode mcp list")
  .option("--json", "вывести проверки в формате JSON")
  .option("--strict", "предупреждения считать ошибкой (для CI)")
  .option("--fix", "применить безопасные исправления (создать отсутствующее, убрать лишнее)")
  .option("--global", "глобальный скоуп: ~/.config/opencode и ~/.config/harness")
  .action(
    async (
      options: { live?: boolean; json?: boolean; strict?: boolean; fix?: boolean; global?: boolean },
      command: Command,
    ) => {
      const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })

      let fix: AutoFixResult | undefined
      if (options.fix === true) {
        fix = await autoFix(scope)
        if (options.json !== true) printAutoFixOutcome(fix)
      }

      const checks: DoctorCheck[] = await runDoctor(scope, { live: options.live })
      if (options.json === true) {
        console.log(JSON.stringify(fix === undefined ? checks : { autoFix: fix, checks }, null, 2))
      } else {
        printDoctorChecks(checks)
      }

      /* Не удалось безопасно исправить — это не успех, даже без --strict */
      if (fix !== undefined && fix.skipped.length > 0) {
        process.exitCode = 1
        return
      }
      process.exitCode = doctorExitCode(checks, { strict: options.strict })
    },
  )
