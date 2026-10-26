import type { AgentDefinition } from "../../manifest/schema.js"
import { classifyValue } from "../../secrets/scan.js"
import { renderAgentToml } from "./toml.js"
import type { CodexStatus } from "./types.js"

/** Markdown-агент OpenCode → кастомный агент Codex (`.codex/agents/<name>.toml`). */

export interface AgentMapResult {
  status: Extract<CodexStatus, "mapped" | "approximate" | "skipped">
  content?: string
  message?: string
}

const BUILTIN_AGENTS = new Set(["default", "worker", "explorer"])

export function mapAgent(name: string, definition: AgentDefinition): AgentMapResult {
  const body = (definition.body ?? "").replace(/\r\n/g, "\n").trim()
  const description = definition.description?.trim() ?? ""
  if (body === "" && description === "") {
    return { status: "skipped", message: `agent:${name}: нет ни description, ни body` }
  }
  if (classifyValue(undefined, `${description}\n${body}`) !== undefined) {
    return {
      status: "skipped",
      message: `agent:${name}: текст агента похож на плейнтекст-секрет — не переношу автоматически`,
    }
  }

  const notes: string[] = []
  if (definition.mode !== undefined) {
    notes.push("mode не переносится: все кастомные агенты Codex — subagents")
  }
  if (definition.permissions !== undefined) {
    notes.push("permissions агента не переносятся: Codex наследует sandbox/approval родителя")
  }
  if (definition.model !== undefined) {
    notes.push("model оставлен вручную: ID моделей OpenCode и Codex различаются")
  }
  if (BUILTIN_AGENTS.has(name)) {
    notes.push("имя совпадает со встроенным агентом Codex — кастомный агент его переопределит")
  }

  const instructions = body === "" ? description : body
  if (body === "") notes.push("developer_instructions взяты из description")

  return {
    status: notes.length === 0 ? "mapped" : "approximate",
    content: renderAgentToml(name, description === "" ? `${name} (перенесён из OpenCode)` : description, instructions),
    ...(notes.length === 0 ? {} : { message: notes.join("; ") }),
  }
}
