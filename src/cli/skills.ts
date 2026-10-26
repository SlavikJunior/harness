import { Command } from "commander"
import pc from "picocolors"
import { buildCatalog } from "../catalog/index.js"
import { fail, dim } from "../core/log.js"

/** `harness skills list`: каталог доступных скиллов из всех источников. */

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export const skillsCommand = new Command("skills")
  .description("Каталог скиллов (зеркала, скан SKILL.md)")

skillsCommand
  .command("list")
  .description("Показать доступные скиллы: harness skills list [запрос] [--source id]")
  .argument("[query]", "подстрока имени или описания")
  .option("--source <id>", "только указанный источник")
  .option("-r, --refresh", "обновить зеркала перед сканом")
  .action(async (query: string | undefined, options: { source?: string; refresh?: boolean }) => {
    try {
      const catalog = await buildCatalog({
        refresh: options.refresh,
        sourceFilter: options.source !== undefined ? [options.source] : undefined,
      })
      if (catalog.skills.length === 0) {
        fail("Скиллы не найдены — проверь ~/.config/harness/sources.yaml")
        process.exitCode = 1
        return
      }
      const match = (item: { name: string; description: string | undefined; source: string }): boolean => {
        if (query === undefined) return true
        const haystack = `${item.source}/${item.name} ${item.description ?? ""}`
        return haystack.toLowerCase().includes(query.toLowerCase())
      }
      for (const item of catalog.skills) {
        if (!match(item)) continue
        const description = truncate(item.description ?? "", 60)
        console.log(`  ${pc.bold(item.name.padEnd(36))} ${pc.dim(`[${item.source}]`)} ${description}`)
      }
      dim("")
      dim("Добавить в манифест: harness add skill <source/name>")
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
