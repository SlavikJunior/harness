import { applyEdits, format, modify, parse, parseTree, findNodeAtLocation, type JSONPath } from "jsonc-parser"
import { deepEqual } from "../core/hash.js"
import { HarnessError } from "../core/errors.js"

/**
 * Точечный редактор JSONC: правки через jsonc-parser с форматированием,
 * комментарии существующего документа сохраняются. Каждая правка считается
 * против актуального текста (offsets относятся к текущему состоянию).
 */

const FORMAT: { insertSpaces: true; tabSize: 2 } = { insertSpaces: true, tabSize: 2 }
export const SCHEMA_URL = "https://opencode.ai/config.json"

/** undefined, если текст корректный JSONC; иначе человекочитаемое сообщение. */
export function validateJsoncText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const errors: { errorCode: number; offset: number }[] = []
  parse(text, errors as never, { allowTrailingComma: true })
  if (errors.length === 0) return undefined
  return `синтаксическая ошибка (позиция ${errors[0]?.offset ?? "?"})`
}

export class ConfigEditor {
  private constructor(private text: string) {}

  static from(text: string | undefined): ConfigEditor {
    if (text === undefined) {
      const base = "{}"
      const formatted = applyEdits(base, format(base, undefined, { ...FORMAT, eol: "\n", insertFinalNewline: true }))
      return new ConfigEditor(formatted)
    }
    const tree = parseTree(text)
    if (tree === undefined) {
      throw new HarnessError("Целевой конфиг не является корректным JSONC", "проверь файл .opencode/opencode.jsonc")
    }
    return new ConfigEditor(text)
  }

  get currentText(): string {
    return this.text
  }

  valueAt(path: JSONPath): unknown {
    const tree = parseTree(this.text)
    if (tree === undefined) return undefined
    const node = findNodeAtLocation(tree, path)
    if (node === undefined) return undefined
    try {
      return JSON.parse(this.text.slice(node.offset, node.offset + node.length))
    } catch {
      return undefined
    }
  }

  /** Наличие ключа по полному пути (включая сам ключ — сканов детей не нужно: modify сам проверит). */
  has(path: JSONPath): boolean {
    return this.valueAt(path) !== undefined
  }

  set(path: JSONPath, value: unknown): boolean {
    if (this.has(path) && deepEqual(this.valueAt(path), value)) return false
    this.text = applyEdits(this.text, modify(this.text, path, value, { formattingOptions: FORMAT }))
    return true
  }

  remove(path: JSONPath): boolean {
    if (!this.has(path)) return false
    this.text = applyEdits(this.text, modify(this.text, path, undefined, { formattingOptions: FORMAT }))
    return true
  }
}
