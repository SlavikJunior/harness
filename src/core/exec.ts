import { execFile } from "node:child_process"
import { HarnessError } from "./errors.js"

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Запуск внешней команды. Отсутствие бинарника — HarnessError c подсказкой. */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // resolve нельзя — бросаем через resolve объекта с флагом missing
        resolve({ code: -1, stdout: "", stderr: `ENOENT: ${command}` })
        return
      }
      const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** run + гарантия успешного кода выхода; текст ошибки включает stderr. */
export async function runChecked(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  const result = await run(command, args, options)
  if (result.code !== 0) {
    throw new HarnessError(
      `Команда завершилась с ошибкой: ${command} ${args.join(" ")}`,
      result.stderr.trim() || undefined,
    )
  }
  return result.stdout
}
