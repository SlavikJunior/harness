import { Command } from "commander"
import { parseDocument, type Document, type YAMLSeq } from "yaml"
import { HarnessError } from "../core/errors.js"
import { readText, writeTextAtomic } from "../core/fs.js"
import { MANIFEST_PATH, validateManifestText } from "../manifest/load.js"
import type { Manifest } from "../manifest/schema.js"
import { scanManifest } from "../secrets/scan.js"
import { ok, fail } from "../core/log.js"
import { printSecretFindings } from "./print.js"
import { resolveScope, scopeFrom, type ScopeInput } from "../scope.js"

/** `harness add skill|mcp`: точечные правки манифеста (комментарии сохраняются). */

function parseKv(pairs: string[] | undefined, separator: string, what: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const pair of pairs ?? []) {
    const index = pair.indexOf(separator)
    if (index <= 0) throw new HarnessError(`Некорректный ${what}: "${pair}"`, `формат: key${separator}value`)
    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (key.length === 0 || value.length === 0) throw new HarnessError(`Некорректный ${what}: "${pair}"`)
    result[key] = value
  }
  return result
}

async function editManifest(input: ScopeInput, edit: (doc: Document) => void): Promise<Manifest> {
  const scope = scopeFrom(input)
  const file = MANIFEST_PATH(scope)
  const text = await readText(file)
  if (text === undefined) {
    throw new HarnessError(
      `Манифест не найден: ${file}`,
      `Сначала: harness${scope.kind === "global" ? " --global" : ""} init`,
    )
  }
  const doc = parseDocument(text)
  edit(doc)
  /* добавленные коллекции — в блочном стиле (draft-манифест использует flow [], {}) */
  for (const key of ["skills", "mcp"]) {
    const node = doc.get(key)
    if (node !== null && node !== undefined && typeof node === "object" && "flow" in node) {
      ;(node as { flow?: boolean }).flow = false
    }
  }
  const nextText = doc.toString()
  const manifest = validateManifestText(nextText) // защита от поломки манифеста своей же правкой
  await writeTextAtomic(file, nextText)
  return manifest
}

export const addCommand = new Command("add")
  .description("Добавить скилл или MCP-сервер в манифест")

addCommand
  .command("skill")
  .description("Добавить скилл: harness add skill <source/name> [--mode vendor|reference]")
  .argument("<reference>", "источник и имя через слэш, например android-skills/navigation-3")
  .option("-m, --mode <mode>", "способ подключения", "vendor")
  .option("--global", "добавить в глобальный манифест (~/.config/harness/harness.yaml)")
  .action(async (reference: string, options: { mode?: string; global?: boolean }, command: Command) => {
    const slash = reference.indexOf("/")
    if (slash <= 0 || slash === reference.length - 1) {
      fail(`Ожидался формат <source/name>, получено: "${reference}"`)
      process.exitCode = 1
      return
    }
    const source = reference.slice(0, slash)
    const name = reference.slice(slash + 1)
    if (options.mode !== undefined && options.mode !== "vendor" && options.mode !== "reference") {
      fail("--mode: только vendor или reference")
      process.exitCode = 1
      return
    }
    const entry: Record<string, string> = options.mode === "reference" ? { source, name, mode: "reference" } : { source, name }

    try {
      const scope = await resolveScope(process.cwd(), { global: command.optsWithGlobals().global === true })
      const manifest = await editManifest(scope, (doc: Document) => {
        const existing = doc.get("skills")
        if (existing !== undefined && existing !== null) {
          // дубликат — идемпотентность add
          const items = (existing as unknown as { toJSON?: () => unknown[] }).toJSON?.() ?? []
          for (const item of items) {
            const rec = item as Record<string, unknown>
            if (rec.source === source && rec.name === name) {
              throw new HarnessError(`Скилл ${reference} уже в манифесте`, "harness plan — текущее состояние")
            }
          }
          ;(existing as YAMLSeq).add(doc.createNode(entry))
        } else {
          doc.set("skills", doc.createNode([entry]))
        }
      })
      ok(`Добавлен скилл: ${reference}`)
      printSecretFindings(scanManifest(manifest))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })

interface HeaderOption {
  headers?: Record<string, string>
}

addCommand
  .command("mcp")
  .description("Добавить MCP-сервер: harness add mcp <name> --local <cmd...> | --url <url>")
  .argument("<name>", "имя сервера")
  .option("--local [command...]", "команда запуска локального сервера")
  .option("--url <url>", "адрес remote-сервера")
  .option("--header <pair>", "заголовок remote: Name:value (повторяемо)", (value, previous: string[] = []) => [...previous, value])
  .option("--env <pair>", "environment local: KEY=value (повторяемо)", (value, previous: string[] = []) => [...previous, value])
  .option("--global", "добавить в глобальный манифест (~/.config/harness/harness.yaml)")
  .action(async (name: string, options: { local?: string[]; url?: string; global?: boolean } & HeaderOption & { env?: string[] }, cli: Command) => {
    try {
      const headers = parseKv((options as { header?: string[] }).header, ":", "--header")
      const environment = parseKv(options.env, "=", "--env")
      const command = options.local
      if ((command === undefined || command.length === 0) && options.url === undefined) {
        fail("Укажи --local <cmd...> или --url <url>")
        process.exitCode = 1
        return
      }
      if (command !== undefined && command.length > 0 && options.url !== undefined) {
        fail("--local и --url взаимоисключающи")
        process.exitCode = 1
        return
      }
      const value =
        command !== undefined && command.length > 0
          ? { type: "local", command, ...(Object.keys(environment).length > 0 ? { environment } : {}) }
          : { type: "remote", url: options.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) }

      const scope = await resolveScope(process.cwd(), { global: cli.optsWithGlobals().global === true })
      const manifest = await editManifest(scope, (doc) => {
        doc.setIn(["mcp", name], doc.createNode(value))
      })
      ok(`Добавлен MCP-сервер: ${name}`)
      printSecretFindings(scanManifest(manifest))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
