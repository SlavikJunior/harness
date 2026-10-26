import path from "node:path"
import type { InstructionsConfig } from "../manifest/schema.js"
import { scopeFrom, type ScopeInput } from "../scope.js"

/**
 * Управляемые блоки в файле инструкций проекта (по умолчанию AGENTS.md).
 *
 * harness владеет только содержимым между маркерами
 * `<!-- harness:begin:NAME -->` и `<!-- harness:end:NAME -->`.
 * Всё остальное в файле — пользовательское и не трогается.
 *
 * Блоки существуют, чтобы `apply` был идемпотентным и предсказуемым:
 * пользовательские правки вне блоков сохраняются, а правки внутри блока
 * видны как drift и перезаписываются из манифеста.
 */

export const DEFAULT_INSTRUCTIONS_FILE = "AGENTS.md"

export function instructionsBegin(name: string): string {
  return `<!-- harness:begin:${name} -->`
}

export function instructionsEnd(name: string): string {
  return `<!-- harness:end:${name} -->`
}

const BEGIN_RE = /^<!-- harness:begin:([A-Za-z0-9_.-]+) -->$/
const END_RE = /^<!-- harness:end:([A-Za-z0-9_.-]+) -->$/
const BLOCK_RE = /<!-- harness:begin:([A-Za-z0-9_.-]+) -->\n[\s\S]*?<!-- harness:end:\1 -->/g

export interface InstructionBlock {
  name: string
  content: string
}

export interface ParsedInstructionBlocks {
  /** имя → содержимое без крайних пустых строк */
  blocks: Map<string, string>
  /** структурные ошибки маркеров: незакрытый/повторный/чужой блок */
  errors: string[]
}

/** Абсолютный путь к файлу инструкций (схема уже запрещает выход за скоуп). */
export function instructionsFilePath(input: ScopeInput, file: string): string {
  return path.resolve(scopeFrom(input).instructionsBase, file)
}

/** Каноничное содержимое блока: LF, без крайних пустых строк. */
export function normalizeInstructionContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim()
}

/** Каноничный вид файла: LF, без крайних пустых строк, один завершающий перевод строки. */
export function canonicalInstructionsText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "")
  return normalized === "" ? "" : `${normalized}\n`
}

/** Разбор маркеров: повреждённая структура — ошибка, а не молчаливая перезапись файла. */
export function parseInstructionBlocks(text: string): ParsedInstructionBlocks {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const blocks = new Map<string, string>()
  const errors: string[] = []
  let open: { name: string; body: string[]; line: number } | undefined

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const begin = BEGIN_RE.exec(trimmed)
    if (begin !== null) {
      const name = begin[1] as string
      if (open !== undefined) {
        errors.push(`строка ${open.line}: блок "${open.name}" не закрыт перед началом "${name}"`)
      }
      open = { name, body: [], line: index + 1 }
      return
    }
    const end = END_RE.exec(trimmed)
    if (end !== null) {
      const name = end[1] as string
      if (open === undefined) {
        errors.push(`строка ${index + 1}: закрыт блок "${name}", который не был открыт`)
        return
      }
      if (open.name !== name) {
        errors.push(`строка ${index + 1}: блок "${open.name}" закрыт маркером "${name}"`)
        open = undefined
        return
      }
      if (blocks.has(name)) errors.push(`строка ${open.line}: блок "${name}" объявлен повторно`)
      else blocks.set(name, normalizeInstructionContent(open.body.join("\n")))
      open = undefined
      return
    }
    if (open !== undefined) open.body.push(line)
  })

  if (open !== undefined) {
    errors.push(`строка ${open.line}: блок "${open.name}" не закрыт`)
  }
  return { blocks, errors }
}

function renderBlock(name: string, content: string): string {
  return `${instructionsBegin(name)}\n${normalizeInstructionContent(content)}\n${instructionsEnd(name)}`
}

/** Удаление блока вместе с одной пустой строкой на стыке, чтобы не копить пробелы. */
function removeManagedBlock(text: string, name: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  for (let start = 0; start < lines.length; start++) {
    if (BEGIN_RE.exec(lines[start]?.trim() ?? "")?.[1] !== name) continue
    let end = start + 1
    while (end < lines.length && END_RE.exec(lines[end]?.trim() ?? "")?.[1] !== name) end++
    if (end >= lines.length) return text // повреждённые маркеры отсекает plan
    lines.splice(start, end - start + 1)
    /* На стыке могло остаться две пустые строки подряд — схлопываем до одной */
    if (start > 0 && lines[start]?.trim() === "" && lines[start - 1]?.trim() === "") lines.splice(start, 1)
    return lines.join("\n")
  }
  return text
}

/**
 * Рендер файла инструкций: обновляет/добавляет желаемые блоки, убирает
 * записанные ранее и сохраняет весь пользовательский текст вне блоков.
 */
export function renderInstructionBlocks(
  text: string | undefined,
  desired: readonly InstructionBlock[],
  remove: readonly string[] = [],
): { text: string; changed: boolean } {
  const current = canonicalInstructionsText(text ?? "")
  const wanted = new Map(desired.map((block) => [block.name, normalizeInstructionContent(block.content)]))
  const present = new Set<string>()

  let next = current
  for (const name of remove) {
    if (wanted.has(name)) continue
    next = removeManagedBlock(next, name)
  }

  next = next.replace(BLOCK_RE, (match, name: string) => {
    present.add(name)
    const content = wanted.get(name)
    return content === undefined ? match : renderBlock(name, content)
  })

  const additions = desired.filter((block) => !present.has(block.name))
  if (additions.length > 0) {
    const rendered = additions.map((block) => renderBlock(block.name, block.content)).join("\n\n")
    next = next === "" ? `${rendered}\n` : `${next.trimEnd()}\n\n${rendered}\n`
  }

  next = canonicalInstructionsText(next)
  return { text: next, changed: next !== current }
}

const INLINE_CODE_RE = /`([^`]+)`/g

/**
 * Пути и команды из inline-code блоков инструкции — для doctor.
 * Берётся первое слово (команда с аргументами `./gradlew assembleDebug`),
 * отбрасываются URL, переменные и шаблоны.
 */
export function extractInstructionPaths(blocks: readonly InstructionBlock[]): string[] {
  const found = new Set<string>()
  for (const block of blocks) {
    for (const match of block.content.matchAll(INLINE_CODE_RE)) {
      const token = (match[1] ?? "").trim().split(/\s+/)[0] ?? ""
      if (!token.includes("/")) continue
      if (token.includes("://") || token.startsWith("~")) continue
      if (/[{}<>$*]/.test(token)) continue
      found.add(token)
    }
  }
  return [...found]
}
