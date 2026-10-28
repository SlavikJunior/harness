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

export interface McpMapOptions {
  /**
   * Разрешить `sh -c`-обёртку для секретов в аргументах.
   * Env-секреты подставляются как `"$VAR"`; литеральные — попадают в
   * config.toml открытым текстом (только явный opt-in).
   */
  allowSecretArgs?: boolean
}

const WHOLE_REF_RE = /^\{(env|file):([^}]+)\}$/
const ANY_REF_RE = /\{(?:env|file):[^}]+\}/
const BEARER_REF_RE = /^Bearer\s+\{(?:env):([^}]+)\}$/i
const SECRET_FLAG_RE =
  /^--?(?:password|passwd|token|api[-_]?key|secret|client[-_]?secret|auth|authorization|bearer)$/i
const SECRET_FLAG_ASSIGN_RE =
  /^--?[A-Za-z0-9_-]*(?:password|passwd|token|api[-_]?key|secret|auth|authorization|bearer)=/i

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Аргумент для `sh -c`: env-подстановки раскрываются, остальное экранируется. */
function renderShellArg(value: string, envVars: Set<string>): string | undefined {
  const whole = WHOLE_REF_RE.exec(value)
  if (whole !== null) {
    if (whole[1] !== "env") return undefined
    envVars.add(whole[2] as string)
    return `"$${whole[2]}"`
  }
  const assignment = /^(--?[^=]+)=(.+)$/.exec(value)
  if (assignment !== null) {
    const ref = WHOLE_REF_RE.exec(assignment[2] as string)
    if (ref !== null) {
      if (ref[1] !== "env") return undefined
      envVars.add(ref[2] as string)
      return `${assignment[1]}="$${ref[2]}"`
    }
  }
  return shellQuote(value)
}

function localMapping(
  name: string,
  server: Extract<MCPServer, { type: "local" }>,
  options: McpMapOptions,
): McpMapResult {
  const [command, ...args] = server.command
  if (command === undefined || command === "") return { status: "skipped", message: "пустая команда" }

  const environment: Record<string, string> = {}
  const envVars = new Set<string>()
  for (const [key, value] of Object.entries(server.environment ?? {})) {
    const whole = WHOLE_REF_RE.exec(value)
    if (whole !== null) {
      if (whole[1] === "file") {
        return { status: "skipped", message: `mcp:${name}: {file:...} не поддерживается Codex` }
      }
      envVars.add(whole[2] as string)
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

  let needsWrapper = false
  let plaintextSecret = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string
    if (SECRET_FLAG_RE.test(argument)) {
      const value = args[index + 1]
      if (value === undefined) return { status: "skipped", message: `mcp:${name}: флаг ${argument} без значения` }
      const whole = WHOLE_REF_RE.exec(value)
      if (whole !== null) {
        if (whole[1] !== "env" || options.allowSecretArgs !== true) {
          return { status: "skipped", message: `mcp:${name}: флаг секрета в аргументах не переносится без --allow-mcp-secret-args` }
        }
        envVars.add(whole[2] as string)
      } else {
        if (options.allowSecretArgs !== true) {
          return { status: "skipped", message: `mcp:${name}: флаг секрета в аргументах не переносится без --allow-mcp-secret-args` }
        }
        plaintextSecret = true
      }
      needsWrapper = true
      index += 1
      continue
    }
    if (SECRET_FLAG_ASSIGN_RE.test(argument)) {
      if (options.allowSecretArgs !== true) {
        return { status: "skipped", message: `mcp:${name}: флаг секрета в аргументах не переносится без --allow-mcp-secret-args` }
      }
      const value = argument.slice(argument.indexOf("=") + 1)
      const whole = WHOLE_REF_RE.exec(value)
      if (whole === null) plaintextSecret = true
      else if (whole[1] !== "env") {
        return { status: "skipped", message: `mcp:${name}: {file:...} в аргументах не поддерживается` }
      } else envVars.add(whole[2] as string)
      needsWrapper = true
      continue
    }
    if (ANY_REF_RE.test(argument)) {
      if (options.allowSecretArgs !== true) {
        return { status: "skipped", message: `mcp:${name}: флаг секрета в аргументах не переносится без --allow-mcp-secret-args` }
      }
      const whole = WHOLE_REF_RE.exec(argument)
      if (whole === null || whole[1] !== "env") {
        return { status: "skipped", message: `mcp:${name}: {file:...} в аргументах не поддерживается` }
      }
      envVars.add(whole[2] as string)
      needsWrapper = true
      continue
    }
    if (classifyValue(undefined, argument) !== undefined) {
      return { status: "skipped", message: `mcp:${name}: в аргументах похоже на плейнтекст-секрет` }
    }
  }

  if (needsWrapper) {
    const rendered = [command, ...args].map((value) => renderShellArg(value, envVars))
    if (rendered.some((value) => value === undefined)) {
      return { status: "skipped", message: `mcp:${name}: не удалось безопасно собрать sh -c` }
    }
    const line = rendered.join(" ")
    return {
      status: "approximate",
      message: plaintextSecret
        ? `mcp:${name}: секрет записан в config.toml открытым текстом`
        : `mcp:${name}: аргументы с секретом перенесены через sh -c`,
      value: {
        command: "sh",
        args: ["-c", `exec ${line}`],
        ...(envVars.size === 0 ? {} : { env_vars: [...envVars] }),
        ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
      },
    }
  }

  return {
    status: "mapped",
    value: {
      command,
      ...(args.length === 0 ? {} : { args }),
      ...(envVars.size === 0 ? {} : { env_vars: [...envVars] }),
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

export function mapMcpServer(name: string, server: MCPServer, options: McpMapOptions = {}): McpMapResult {
  return server.type === "local" ? localMapping(name, server, options) : remoteMapping(name, server)
}
