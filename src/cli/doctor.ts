import { Command } from "commander"
import { runDoctor, type DoctorCheck } from "../verify/doctor.js"
import { printDoctorChecks } from "./print.js"

/** `harness doctor`: проверка фактического состояния. */

export const doctorCommand = new Command("doctor")
  .description("Проверить состояние харнесса против манифеста")
  .option("--live", "дополнительно прогнать opencode --version и opencode mcp list")
  .option("--json", "вывести проверки в формате JSON")
  .action(async (options: { live?: boolean; json?: boolean }) => {
    const projectRoot = process.cwd()
    const checks: DoctorCheck[] = await runDoctor(projectRoot, { live: options.live })
    if (options.json === true) {
      console.log(JSON.stringify(checks, null, 2))
      return
    }
    printDoctorChecks(checks)
  })
