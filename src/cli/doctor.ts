import { Command } from "commander"
import { runDoctor, type DoctorCheck } from "../verify/doctor.js"
import { printDoctorChecks } from "./print.js"
import { doctorExitCode } from "./json.js"
import { resolveScope } from "../scope.js"

/** `harness doctor`: проверка фактического состояния. */

export const doctorCommand = new Command("doctor")
  .description("Проверить состояние харнесса против манифеста")
  .option("--live", "дополнительно прогнать opencode --version и opencode mcp list")
  .option("--json", "вывести проверки в формате JSON")
  .option("--strict", "предупреждения считать ошибкой (для CI)")
  .option("--global", "глобальный скоуп: ~/.config/opencode и ~/.config/harness")
  .action(async (options: { live?: boolean; json?: boolean; strict?: boolean; global?: boolean }, command: Command) => {
    const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })
    const checks: DoctorCheck[] = await runDoctor(scope, { live: options.live })
    if (options.json === true) {
      console.log(JSON.stringify(checks, null, 2))
    } else {
      printDoctorChecks(checks)
    }
    process.exitCode = doctorExitCode(checks, { strict: options.strict })
  })
