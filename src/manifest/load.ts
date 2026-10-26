import { parse, parseDocument, LineCounter, type Document } from "yaml"
import { manifestSchema, reservedConfigKeys, type Manifest } from "./schema.js"
import { ManifestValidationError, HarnessError } from "../core/errors.js"
import { readText } from "../core/fs.js"
import { scopeFrom, type ScopeInput } from "../scope.js"

/**
 * Загрузка и валидация манифеста `harness.yaml` — единственного
 * source of truth желаемого состояния харнесса.
 *
 * Ошибки выдаются с 1-базированным номером строки по dot-path
 * (`mcp.playwright.type`, `skills[2].name`), позиция берётся из AST YAML.
 */

export { MANIFEST_FILE } from "./file.js"
export type { Manifest, SkillEntry, SkillMode, MCPServer, MCPLocal, MCPRemote } from "./schema.js"

export const MANIFEST_PATH = (input: ScopeInput): string => scopeFrom(input).manifestFile

interface RawIssue {
  path: string
  message: string
}

/** Разбор dot-path на сегменты: "skills[2].name" → ["skills", 2, "name"]. */
function segments(dotPath: string): (string | number)[] {
  const result: (string | number)[] = []
  let buffer = ""
  for (let i = 0; i < dotPath.length; i++) {
    const char = dotPath[i]
    if (char === ".") {
      /* после "]" буфер уже пуст — пустые сегменты не пушим */
      if (buffer !== "") {
        result.push(buffer)
        buffer = ""
      }
    } else if (char === "[") {
      if (buffer !== "") {
        result.push(buffer)
        buffer = ""
      }
      const end = dotPath.indexOf("]", i)
      if (end === -1) {
        result.push(dotPath.slice(i + 1))
        return result
      }
      const index = dotPath.slice(i + 1, end)
      result.push(/^\d+$/.test(index) ? Number(index) : index)
      i = end
    } else {
      buffer += char
    }
  }
  if (buffer !== "") result.push(buffer)
  return result
}

interface MapItemLike {
  key?: { value?: unknown }
  value?: unknown
}

/** Строка для dot-path; undefined, если узел не найден. */
function issueLine(doc: Document, counter: LineCounter | undefined, dotPath: string): number | undefined {
  const parts = segments(dotPath)
  let node: unknown = doc.contents
  for (const part of parts) {
    if (!node || typeof node !== "object" || !("items" in node)) return undefined
    const items = (node as { items: unknown[] }).items as unknown[]
    if (typeof part === "number") {
      /* в YAMLSeq items — сами узлы (не Pair) */
      node = items[part]
    } else {
      const found = (items as MapItemLike[]).find((it) => it.key?.value === part)
      if (!found) return undefined
      node = found.value ?? found.key
    }
  }
  if (!node || typeof node !== "object" || counter === undefined) return undefined
  const range = (node as { range?: number[] }).range
  const offset = range?.[0]
  if (offset === undefined) return undefined
  return counter.linePos(offset).line
}

function positionIssues(text: string, issues: RawIssue[]): { path: string; message: string; line?: number }[] {
  let doc: Document
  try {
    const counter = new LineCounter()
    doc = parseDocument(text, { lineCounter: counter })
    return issues.map((issue) => {
      const line = issueLine(doc, counter, issue.path)
      return line === undefined ? { ...issue } : { ...issue, line }
    })
  } catch {
    return issues
  }
}

/** Валидация текста манифеста (чистая функция — удобна для тестов). */
export function validateManifestText(text: string): Manifest {
  let doc: Document
  try {
    doc = parseDocument(text)
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error)
    throw new ManifestValidationError([{ path: "(синтаксис)", message }], "harness.yaml")
  }
  const syntaxIssues = doc.errors.map((error) => ({
    path: "(синтаксис)",
    message: error.message.split("\n")[0] as string,
  }))
  if (syntaxIssues.length > 0) {
    throw new ManifestValidationError(positionIssues(text, syntaxIssues), "harness.yaml")
  }

  const value: unknown = parse(text)
  const parsed = manifestSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.reduce((acc: string, part) => {
        if (typeof part === "number") return `${acc}[${part}]`
        return acc === "" ? String(part) : `${acc}.${String(part)}`
      }, "") || "(корень)",
      message: issue.message,
    }))
    throw new ManifestValidationError(positionIssues(text, issues), "harness.yaml")
  }
  checkSemantics(parsed.data, text)
  return parsed.data
}

/** Семантические проверки: дубли скиллов, зарезервированные ключи config. */
function checkSemantics(manifest: Manifest, text: string): void {
  const issues: RawIssue[] = []
  const seen = new Set<string>()
  for (const [index, skill] of (manifest.skills ?? []).entries()) {
    const key = `${skill.source}/${skill.name}`
    if (seen.has(key)) issues.push({ path: `skills[${index}]`, message: `дубликат скилла ${key}` })
    seen.add(key)
  }
  const reserved = Object.keys(manifest.config ?? {}).filter((key) =>
    (reservedConfigKeys as readonly string[]).includes(key),
  )
  for (const key of reserved) {
    issues.push({
      path: `config.${key}`,
      message: "ключ зарезервирован — им управляет одноимённое поле верхнего уровня манифеста",
    })
  }
  if (issues.length > 0) throw new ManifestValidationError(positionIssues(text, issues), "harness.yaml")
}

/** Загрузка манифеста с диска. */
export async function loadManifest(input: ScopeInput): Promise<Manifest> {
  const scope = scopeFrom(input)
  const file = MANIFEST_PATH(scope)
  const text = await readText(file)
  if (text === undefined) {
    throw new HarnessError(
      `Манифест не найден: ${file}`,
      scope.kind === "global"
        ? "Создать глобальный черновик: harness --global init"
        : "Сгенерировать черновик: harness init",
    )
  }
  return validateManifestText(text)
}
