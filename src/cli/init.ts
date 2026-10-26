import { Command } from "commander"
import { detectStacks } from "../detect/index.js"
import { draftManifest } from "../manifest/draft.js"
import { MANIFEST_PATH } from "../manifest/load.js"
import { pathExists, writeTextAtomic } from "../core/fs.js"
import { ok, fail, info, dim } from "../core/log.js"

/** `harness init`: черновик манифеста по детекции стека. */

export const initCommand = new Command("init")
  .description("Создать черновик harness.yaml по детекции стека проекта")
  .option("-f, --force", "перезаписать существующий манифест")
  .action(async (options: { force?: boolean }) => {
    const projectRoot = process.cwd()
    const detection = await detectStacks(projectRoot)
    const stacks = detection.stacks.map((stack) => stack.title).join(", ") || "не определён"

    const file = MANIFEST_PATH(projectRoot)
    if ((await pathExists(file)) && options.force !== true) {
      fail(`Манифест уже существует: ${file}`)
      dim("Для перезаписи: harness init --force")
      process.exitCode = 1
      return
    }
    await writeTextAtomic(file, draftManifest(detection))
    ok(`Манифест создан: harness.yaml`)
    if (detection.stacks.length > 0) {
      info(`Обнаружен стек: ${stacks}`)
      for (const stack of detection.stacks) {
        dim(`  • ${stack.id}: ${stack.markers.join(", ")}`)
      }
    } else {
      dim("  • стек не распознан — заполни skills/mcp/config вручную")
    }
    info("Дальше: правь манифест → harness plan → harness apply")
  })
