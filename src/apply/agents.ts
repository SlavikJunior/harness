import path from "node:path"
import { stringify } from "yaml"
import type { AgentDefinition } from "../manifest/schema.js"
import { displayPath, scopeFrom, type ScopeInput } from "../scope.js"

/**
 * Markdown-агенты: frontmatter + body → `.opencode/agents/<name>.md`.
 *
 * Файл целиком управляется harness (как блок инструкций): рендер
 * детерминирован, поэтому сравнение содержимого = сравнение строк.
 * Пользовательские агенты с другими именами не трогаются.
 */

export function agentsDir(input: ScopeInput): string {
  return scopeFrom(input).agentsDir
}

export function agentFilePath(input: ScopeInput, name: string): string {
  return path.join(agentsDir(input), `${name}.md`)
}

export function agentRelativePath(input: ScopeInput, name: string): string {
  return displayPath(scopeFrom(input), agentFilePath(input, name))
}

/** Единый вид для сравнения: LF и ровно один хвостовой перевод строки. */
export function normalizeAgentContent(text: string): string {
  return `${text.replace(/\r\n/g, "\n").trimEnd()}\n`
}

/** Канонический markdown агента: фиксированный порядок полей frontmatter. */
export function renderAgent(definition: AgentDefinition): string {
  const frontmatter: Record<string, unknown> = {}
  if (definition.description !== undefined) frontmatter.description = definition.description
  if (definition.mode !== undefined) frontmatter.mode = definition.mode
  if (definition.model !== undefined) frontmatter.model = definition.model
  if (definition.permissions !== undefined) frontmatter.permissions = definition.permissions

  const header = stringify(frontmatter, { lineWidth: 0 }).trimEnd()
  const body = (definition.body ?? "").trim()
  return normalizeAgentContent(body === "" ? `---\n${header}\n---` : `---\n${header}\n---\n\n${body}`)
}
