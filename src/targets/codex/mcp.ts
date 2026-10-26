import type { MCPServer } from "../../manifest/schema.js"
import { classifyValue } from "../../secrets/scan.js"

/**
 * OpenCode MCP → Codex `[mcp_servers.<name>]`.
 *
 * Главное отличие: Codex не подставляет `{env:VAR}` в произвольные строки.
 * Поэтому:
 * - env stdio целиком `{env:VAR}` → `env_vars = ["VAR"]` (проброс окружения);
 * - `Authorization: Bearer {env:VAR}` → `bearer_token_env_var = "VAR"`;
 * - остальные заголовки `{env:VAR}` → `env_http_headers`;
 * - всё, что нельзя выразить безопасно, пропускается с отчётом.
 */

export type McpMapStatus = "mapped" | "approximate" | "skipped"

export interface McpMapResult {
  status: McpMapStatus
  value?: Record<string, unknown>
  message?: string
}

const WHOLE_REF_RE = /^\{(env|file):([^}]+)\}$/
const ANY_REF_RE = /\{(?:env|file):[^}]+\}/
const BEARER_REF_RE = /^Bearer\s+\{(?:env):([^}]+)\}$/i

function checkArg(value: string): string | undefined {
  if (ANY_REF_RE.test(value)) return "в аргументах есть подстановка {env:...}, которую Codex не раскрывает"
  if (classifyValue(undefined, value) !== undefined) return "в аргументах похоже на плейнтекст-секрет"
  return undefined
}

function localMapping(name: string, server: Extract<MCPServer, { type: "local" }>): McpMapResult {
  const [command, ...args] = server.command
  if (command === undefined || command === "") return { status: "skipped", message: "пустая команда" }
  for (const argument of server.command) {
    const reason = checkArg(argument)
    if (reason !== undefined) return { status: "skipped", message: `mcp:${name}: ${reason}` }
  }

  const environment: Record<string, string> = {}
  const envVars: string[] = []
  for (const [key, value] of Object.entries(server.environment ?? {})) {
    const whole = WHOLE_REF_RE.exec(value)
    if (whole !== null) {
      if (whole[1] === "file") {
        return { status: "skipped", message: `mcp:${name}: {file:...} не поддерживается Codex` }
      }
      envVars.push(whole[2] as string)
      continue
    }
    if (ANY_REF_RE.test(value)) {
      return {
        status: "skipped",
        message: `mcp:${name}: значение ${key} смешивает env-подстановку с текстом — Codex так не умеет`,
      }
    }
    if (classifyValue(key, value) !== undefined) {
      return { status: "skipped", message: `mcp:${name}: значение ${key} похоже на секрет` }
    }
    environment[key] = value
  }

  return {
    status: "mapped",
    value: {
      command,
      ...(args.length === 0 ? {} : { args }),
      ...(envVars.length === 0 ? {} : { env_vars: [...new Set(envVars)] }),
      ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
    },
  }
}

function remoteMapping(name: string, server: Extract<MCPServer, { type: "remote" }>): McpMapResult {
  if (ANY_REF_RE.test(server.url)) {
    return { status: "skipped", message: `mcp:${name}: URL содержит env-подстановку — Codex её не раскрывает` }
  }
  if (classifyValue("url", server.url) !== undefined) {
    return { status: "skipped", message: `mcp:${name}: URL содержит учётные данные` }
  }

  const httpHeaders: Record<string, string> = {}
  const envHeaders: Record<string, string> = {}
  let bearer: string | undefined

  for (const [header, value] of Object.entries(server.headers ?? {})) {
    const bearerMatch = BEARER_REF_RE.exec(value)
    if (bearerMatch !== null && header.toLowerCase() === "authorization") {
      bearer = bearerMatch[1] as string
      continue
    }

    const whole = WHOLE_REF_RE.exec(value)
    if (whole !== null) {
      if (whole[1] === "file") {
        return { status: "skipped", message: `mcp:${name}: заголовок ${header} использует {file:...}` }
      }
      envHeaders[header] = whole[2] as string
      continue
    }
    if (ANY_REF_RE.test(value)) {
      return {
        status: "skipped",
        message: `mcp:${name}: заголовок ${header} смешивает env-подстановку с текстом`,
      }
    }
    if (classifyValue(header, value) !== undefined) {
      return { status: "skipped", message: `mcp:${name}: заголовок ${header} похож на плейнтекст-секрет` }
    }
    httpHeaders[header] = value
  }

  return {
    status: "approximate",
    message: `mcp:${name}: Codex remote = streamable HTTP`,
    value: {
      url: server.url,
      ...(bearer === undefined ? {} : { bearer_token_env_var: bearer }),
      ...(Object.keys(httpHeaders).length === 0 ? {} : { http_headers: httpHeaders }),
      ...(Object.keys(envHeaders).length === 0 ? {} : { env_http_headers: envHeaders }),
    },
  }
}

export function mapMcpServer(name: string, server: MCPServer): McpMapResult {
  return server.type === "local" ? localMapping(name, server) : remoteMapping(name, server)
}
