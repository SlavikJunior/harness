#!/usr/bin/env node
import { Command } from "commander"
import { HarnessError } from "../core/errors.js"
import { fail } from "../core/log.js"
import { initCommand } from "./init.js"
import { planCommand } from "./plan.js"
import { applyCommand } from "./apply.js"
import { updateCommand } from "./update.js"
import { doctorCommand } from "./doctor.js"
import { addCommand } from "./add.js"
import { skillsCommand } from "./skills.js"
import { sourcesCommand } from "./sources.js"

/** Точка входа harness CLI. Все ошибки — аккуратный вывод без стектрейсов. */

const program = new Command()
program
  .name("harness")
  .description("Декларативная настройка OpenCode-харнесса проекта по манифесту harness.yaml")
  .version("0.1.0")

program.addCommand(initCommand)
program.addCommand(planCommand)
program.addCommand(applyCommand)
program.addCommand(updateCommand)
program.addCommand(doctorCommand)
program.addCommand(addCommand)
program.addCommand(skillsCommand)
program.addCommand(sourcesCommand)

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof HarnessError) {
    fail(error.message, error.hint)
    process.exitCode = 1
    return
  }
  fail(`Внутренняя ошибка: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})
