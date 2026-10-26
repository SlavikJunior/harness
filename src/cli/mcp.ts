import { Command } from "commander"
import pc from "picocolors"
import { stringify } from "yaml"
import { HarnessError } from "../core/errors.js"
import { fail, ok, warn, dim } from "../core/log.js"
import { scanManifest } from "../secrets/scan.js"
import { resolveScope } from "../scope.js"
import { createRegistryClient } from "../registry/index.js"
import {
  draftFromRegistry,
  registryServerView,
  summarizeTransport,
  type RegistryDraft,
} from "../registry/index.js"
import { editManifest } from "./manifest-edit.js"
import { printSecretFindings } from "./print.js"

/**
 * `harness mcp search|add`: каталог официального MCP Registry.
 *
 * Каталог никогда не устанавливает серверы сам: результат `add` — только
 * запись в `harness.yaml`, дальше обычный `plan → apply`. Секреты из реестра
 * превращаются в `{env:VAR}`; значения не печатаются.
 */

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new HarnessError(`${label}: ожидалось положительное целое, получено "${raw}"`)
  }
  return value
}

function printRegistryWarning(result: { source: string; warning?: string }): void {
  if (result.warning !== undefined) warn(result.warning)
  else if (result.source === "cache") dim("  (из кэша; обновить: --refresh)")
}

function printDraft(draft: RegistryDraft, options: { dryRun: boolean }): void {
  const transport = draft.transport === "remote" ? "remote" : "local"
  console.log("")
  console.log(
    `${options.dryRun ? pc.dim("(dry-run)") : pc.green("✔")} ${pc.bold(`mcp:${draft.name}`)} ${pc.dim(`(${transport})`)}`,
  )
  console.log(`  реестр: ${draft.registryName}@${draft.registryVersion}`)
  if (draft.repository !== undefined) console.log(`  репозиторий: ${draft.repository}`)
  if (draft.server.type === "local") {
    console.log(`  команда: ${draft.server.command.join(" ")}`)
  } else {
    console.log(`  url: ${draft.server.url}`)
  }
  if (draft.requiredEnv.length > 0) {
    console.log(`  ${pc.yellow("требует env:")} ${draft.requiredEnv.join(", ")}`)
    console.log(pc.dim("  → задай переменные окружения; в манифест попадут только ссылки {env:VAR}"))
  }
  for (const warning of draft.warnings) console.log(`  ${pc.yellow("⚠")} ${warning}`)
  if (options.dryRun) {
    console.log("")
    console.log(pc.dim("Запись, которая появится в harness.yaml:"))
    console.log(
      stringify({ mcp: { [draft.name]: draft.server } }, { lineWidth: 0 })
        .trimEnd()
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    )
  }
}

export const mcpCommand = new Command("mcp")
  .description("Каталог MCP-серверов (официальный MCP Registry)")

mcpCommand
  .command("search")
  .description("Найти MCP-серверы: harness mcp search <query> [--json] [--refresh]")
  .argument("<query>", "подстрока имени, описания или title")
  .option("--json", "вывести результат в формате JSON")
  .option("--refresh", "игнорировать кэш (TTL 24 часа)")
  .option("--limit <n>", "сколько серверов показать", "20")
  .action(async (query: string, options: { json?: boolean; refresh?: boolean; limit?: string }) => {
    try {
      const limit = parsePositiveInt(options.limit, 20, "--limit")
      const client = createRegistryClient({ refresh: options.refresh })
      const result = await client.search(query)
      const shown = result.servers.slice(0, limit)
      if (options.json === true) {
        console.log(
          JSON.stringify(
            {
              query,
              total: result.servers.length,
              source: result.source,
              fetchedAt: result.fetchedAt,
              ...(result.warning === undefined ? {} : { warning: result.warning }),
              servers: shown.map(registryServerView),
            },
            null,
            2,
          ),
        )
        if (result.servers.length === 0) process.exitCode = 1
        return
      }
      printRegistryWarning(result)
      if (result.servers.length === 0) {
        fail(`Ничего не найдено: "${query}"`, "уточни запрос или обнови кэш: --refresh")
        process.exitCode = 1
        return
      }
      console.log("")
      for (const server of shown) {
        const title = server.title === undefined ? "" : pc.dim(` — ${truncate(server.title, 60)}`)
        const deprecated = server.status === "deprecated" ? pc.yellow(" [deprecated]") : ""
        console.log(`  ${pc.bold(server.name)}${pc.dim(`@${server.version}`)}${deprecated}${title}`)
        const summary = summarizeTransport(server)
        const unsupported = summary.supported ? "" : pc.yellow(" [не поддерживается автоматически]")
        console.log(`    ${pc.dim(summary.transport)}${unsupported}`)
        if (server.repository !== undefined) console.log(`    ${pc.dim(truncate(server.repository, 100))}`)
      }
      if (result.servers.length > shown.length) {
        dim(`  … ещё ${result.servers.length - shown.length} (--limit)`)
      }
      console.log("")
      dim(`Добавить: harness mcp add <registry-name>  ·  сначала проверь репозиторий и требования`)
      dim("Реестр не проверяет безопасность кода: provenance — на стороне пользователя")
    } catch (error) {
      if (error instanceof HarnessError) fail(error.message, error.hint)
      else fail(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })

mcpCommand
  .command("add")
  .description("Добавить MCP-сервер из реестра в манифест")
  .argument("<name>", "имя в реестре, например io.github.user/server")
  .option("--name <mcpName>", "имя MCP-сервера в манифесте (по умолчанию — последний сегмент)")
  .option("--version <version>", "версия сервера в реестре", "latest")
  .option("--remote", "использовать remote-транспорт")
  .option("--package <type>", "тип пакета: npm|pypi|oci|cargo")
  .option("--dry-run", "показать запись, не менять манифест")
  .option("--refresh", "игнорировать кэш реестра")
  .option("--global", "добавить в глобальный манифест (~/.config/harness/harness.yaml)")
  .action(
    async (
      name: string,
      options: {
        name?: string
        version?: string
        remote?: boolean
        package?: string
        dryRun?: boolean
        refresh?: boolean
        global?: boolean
      },
      cli: Command,
    ) => {
      try {
        if (options.remote === true && options.package !== undefined) {
          fail("--remote и --package взаимоисключающи")
          process.exitCode = 1
          return
        }
        const version = options.version === undefined || options.version === "latest" ? undefined : options.version
        const client = createRegistryClient({ refresh: options.refresh })
        const result = await client.get(name, version)
        if (result.warning !== undefined) warn(result.warning)
        const draft = draftFromRegistry(result.server, {
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.remote === true ? { remote: true } : {}),
          ...(options.package === undefined ? {} : { packageType: options.package }),
        })

        if (options.dryRun === true) {
          printDraft(draft, { dryRun: true })
          return
        }

        const scope = await resolveScope(process.cwd(), { global: cli.optsWithGlobals().global === true })
        const manifest = await editManifest(scope, (doc) => {
          const existing = doc.getIn(["mcp", draft.name])
          if (existing !== undefined && existing !== null) {
            throw new HarnessError(
              `MCP-сервер "${draft.name}" уже есть в манифесте`,
              "выбери другое имя: --name <mcpName>",
            )
          }
          if (doc.get("mcp") === null) doc.set("mcp", doc.createNode({}))
          doc.setIn(["mcp", draft.name], doc.createNode(draft.server))
        })
        printDraft(draft, { dryRun: false })
        printSecretFindings(scanManifest(manifest))
        console.log("")
        ok("Добавлено в манифест")
        dim(`Проверить: harness${scope.kind === "global" ? " --global" : ""} plan`)
      } catch (error) {
        if (error instanceof HarnessError) fail(error.message, error.hint)
        else fail(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    },
  )
