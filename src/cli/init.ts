import { Command } from "commander"
import { detectStacks } from "../detect/index.js"
import { draftManifest } from "../manifest/draft.js"
import { MANIFEST_PATH } from "../manifest/load.js"
import { pathExists, writeTextAtomic } from "../core/fs.js"
import { ok, fail, info, dim } from "../core/log.js"
import { displayPath, resolveScope } from "../scope.js"

/** `harness init`: черновик манифеста по детекции стека. */

export const initCommand = new Command("init")
  .description("Создать черновик harness.yaml по детекции стека проекта")
  .option("-f, --force", "перезаписать существующий манифест")
  .option("--global", "создать глобальный манифест ~/.config/harness/harness.yaml")
  .action(async (options: { force?: boolean; global?: boolean }, command: Command) => {
    const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })
    const prefix = scope.kind === "global" ? "harness --global" : "harness"
    /* Глобальный харнесс не привязан к стеку текущего каталога */
    const detection = scope.kind === "global" ? { stacks: [] } : await detectStacks(scope.root)
    const stacks = detection.stacks.map((stack) => stack.title).join(", ") || "не определён"

    const file = MANIFEST_PATH(scope)
    if ((await pathExists(file)) && options.force !== true) {
      fail(`Манифест уже существует: ${displayPath(scope, file)}`)
      dim(`Для перезаписи: ${prefix} init --force`)
      process.exitCode = 1
      return
    }
    await writeTextAtomic(file, draftManifest(detection, { scope: scope.kind }))
    ok(`Манифест создан: ${displayPath(scope, file)}`)
    if (detection.stacks.length > 0) {
      info(`Обнаружен стек: ${stacks}`)
      for (const stack of detection.stacks) {
        dim(`  • ${stack.id}: ${stack.markers.join(", ")}`)
      }
    } else {
      dim(
        scope.kind === "global"
          ? "  • глобальный скоуп — заполни skills/mcp/config вручную"
          : "  • стек не распознан — заполни skills/mcp/config вручную",
      )
    }
    info(`Дальше: ${prefix} plan → ${prefix} apply`)
  })
