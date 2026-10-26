import path from "node:path"
import { Command } from "commander"
import pc from "picocolors"
import { parseDocument } from "yaml"
import { loadSources, sourcesFile, validateSourcesText } from "../catalog/sources.js"
import { readText, writeTextAtomic, isDirectory } from "../core/fs.js"
import { HarnessError } from "../core/errors.js"
import { ok, dim, fail } from "../core/log.js"

/** `harness sources list|add`: управление источниками скиллов. */

export const sourcesCommand = new Command("sources")
  .description("Источники скиллов (~/.config/harness/sources.yaml)")

sourcesCommand
  .command("list")
  .description("Показать настроенные источники")
  .action(async () => {
    const sources = await loadSources()
    for (const [id, def] of Object.entries(sources.sources)) {
      const target = def.type === "repo" ? def.url : def.path
      console.log(`  ${pc.bold(id.padEnd(20))} ${pc.dim(def.type.padEnd(6))} ${target}`)
    }
    dim("")
    dim(`Файл источника: ${sourcesFile()}`)
  })

async function writeUserSources(edit: (doc: ReturnType<typeof parseDocument>) => void): Promise<void> {
  const file = sourcesFile()
  const text = await readText(file)
  let doc
  if (text === undefined) {
    doc = parseDocument("sources: {}\n")
  } else {
    validateSourcesText(text, file)
    doc = parseDocument(text)
  }
  edit(doc)
  await writeTextAtomic(file, doc.toString())
}

sourcesCommand
  .command("add")
  .description("Добавить источник: harness sources add <id> --url <git-url> | --path <dir>")
  .argument("<id>", "идентификатор источника")
  .option("--url <url>", "git-репозиторий (клонируется в зеркало)")
  .option("--path <path>", "локальная директория со скиллами")
  .action(async (id: string, options: { url?: string; path?: string }) => {
    try {
      if ((options.url === undefined) === (options.path === undefined)) {
        fail("Укажи ровно одно: --url или --path")
        process.exitCode = 1
        return
      }
      await writeUserSources((doc) => {
        const value = options.url !== undefined ? { type: "repo", url: options.url } : { type: "local", path: options.path }
        doc.setIn(["sources", id], doc.createNode(value))
      })
      if (options.path !== undefined && !(await isDirectory(path.resolve(options.path)))) {
        ok(`Источник добавлен: ${id} (путь пока не существует — создай директорию)`)
      } else {
        ok(`Источник добавлен: ${id}`)
      }
      dim("Скиллы: harness skills list")
    } catch (error) {
      if (error instanceof HarnessError) {
        fail(error.message, error.hint)
      } else {
        fail(error instanceof Error ? error.message : String(error))
      }
      process.exitCode = 1
    }
  })
