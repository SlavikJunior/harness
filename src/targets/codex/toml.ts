import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser"
import { HarnessError } from "../../core/errors.js"
import { maskText } from "../../secrets/scan.js"

/**
 * TOML-редактор для Codex config.toml.
 *
 * Глобальный `~/.codex/config.toml` принадлежит пользователю, поэтому
 * переписывать файл целиком нельзя. Ast-парсер даёт диапазоны таблиц;
 * harness удаляет/добавляет только `[mcp_servers.<name>]` (и вложенные
 * `.env`/`.http_headers`), сохраняя остальные ключи и комментарии.
 */

export interface TomlTableInfo {
  key: string[]
  range: [number, number]
}

export interface ParsedToml {
  text: string
  ast: AST.TOMLProgram
  value: Record<string, unknown>
  tables: TomlTableInfo[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseTomlText(text: string, file = "config.toml"): ParsedToml {
  let ast: AST.TOMLProgram
  try {
    ast = parseTOML(text)
  } catch (error) {
    throw new HarnessError(
      `Не удалось разобрать ${file}: ${maskText(error instanceof Error ? error.message : String(error))}`,
      "исправь TOML вручную: harness не перезаписывает невалидный файл",
    )
  }
  const value = getStaticTOMLValue(ast)
  const tables: TomlTableInfo[] = []
  for (const top of ast.body) {
    if (top.type === "TOMLTopLevelTable") {
      for (const node of top.body) {
        if (node.type !== "TOMLTable") continue
        const key = getStaticTOMLValue(node.key)
        if (!Array.isArray(key) || !key.every((part) => typeof part === "string")) continue
        tables.push({ key: key as string[], range: node.range as [number, number] })
      }
    }
  }
  return {
    text,
    ast,
    value: isRecord(value) ? value : {},
    tables,
  }
}

export function mcpServerValue(doc: ParsedToml, name: string): unknown {
  const servers = doc.value.mcp_servers
  return isRecord(servers) ? servers[name] : undefined
}

export function hasMcpServer(doc: ParsedToml, name: string): boolean {
  return mcpServerValue(doc, name) !== undefined
}

export function mcpTableRanges(doc: ParsedToml, name: string): [number, number][] {
  return doc.tables
    .filter((table) => table.key[0] === "mcp_servers" && table.key[1] === name)
    .map((table) => table.range)
}

/** TOML-ключ: bare, если это безопасно, иначе в кавычках. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

/** Строка TOML: JSON-экранирование совместимо с basic string. */
export function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`
}

function tomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values)
  if (entries.length === 0) return "{}"
  return `{ ${entries.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`
}

export function renderMcpTable(name: string, value: Record<string, unknown>): string {
  const lines = [`[mcp_servers.${tomlKey(name)}]`]
  const scalars: [string, string][] = []
  const tables: [string, Record<string, string>][] = []
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string") scalars.push([key, tomlString(field)])
    else if (Array.isArray(field) && field.every((item) => typeof item === "string")) {
      scalars.push([key, tomlArray(field as string[])])
    } else if (isRecord(field) && Object.values(field).every((item) => typeof item === "string")) {
      tables.push([key, field as Record<string, string>])
    } else {
      throw new HarnessError(`Неподдерживаемое поле MCP-сервера Codex: ${name}.${key}`)
    }
  }
  for (const [key, rendered] of scalars) {
    lines.push(`${tomlKey(key)} = ${rendered}`)
  }
  for (const [key, field] of tables) {
    lines.push(`${tomlKey(key)} = ${tomlInlineTable(field)}`)
  }
  return `${lines.join("\n")}\n`
}

export function renderAgentToml(name: string, description: string, instructions: string): string {
  return [
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlString(instructions)}`,
    "",
  ].join("\n")
}

function lineStart(text: string, index: number): number {
  const newline = text.lastIndexOf("\n", index - 1)
  return newline === -1 ? 0 : newline + 1
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index)
  return newline === -1 ? text.length : newline + 1
}

/** Удаление диапазонов с аккуратной склейкой пустых строк на стыках. */
function removeRanges(text: string, ranges: readonly [number, number][]): string {
  let result = text
  const ordered = [...ranges].toSorted((left, right) => right[0] - left[0])
  for (const [rawStart, rawEnd] of ordered) {
    const start = lineStart(result, rawStart)
    const end = lineEnd(result, rawEnd)
    const before = result.slice(0, start)
    const after = result.slice(end)
    let joined = before + after
    if (before.endsWith("\n\n") && after.startsWith("\n")) joined = before + after.slice(1)
    else if (before.endsWith("\n") && after.startsWith("\n\n")) joined = before + after.slice(1)
    result = joined
  }
  return result
}

function canonicalToml(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trimEnd()
  return normalized === "" ? "" : `${normalized}\n`
}

/**
 * Удаляет указанные MCP-серверы и добавляет новые. Сервер, определённый
 * inline-таблицей (`mcp_servers = { ... }`), автоматически не трогается:
 * это чужая структура, которую нельзя безопасно отредактировать построчно.
 */
export function applyMcpChanges(
  doc: ParsedToml,
  changes: { remove: readonly string[]; append: Readonly<Record<string, Record<string, unknown>>> },
  file = "config.toml",
): string {
  const ranges: [number, number][] = []
  for (const name of changes.remove) {
    const found = mcpTableRanges(doc, name)
    if (found.length === 0 && hasMcpServer(doc, name)) {
      throw new HarnessError(
        `MCP-сервер "${name}" задан в ${file} не таблицей [mcp_servers.${name}]`,
        "перенеси его вручную: harness не редактирует inline-структуры",
      )
    }
    ranges.push(...found)
  }

  let text = removeRanges(doc.text, ranges)
  const blocks = Object.entries(changes.append).map(([name, value]) => renderMcpTable(name, value))
  if (blocks.length > 0) {
    const base = canonicalToml(text)
    text = base === "" ? `${blocks.join("\n")}` : `${base}\n${blocks.join("\n")}`
  }
  text = canonicalToml(text)

  /* Валидируем результат до записи: сломанный TOML не должен попасть на диск */
  parseTomlText(text, file)
  return text
}
