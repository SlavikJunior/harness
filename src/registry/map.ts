import { HarnessError } from "../core/errors.js"
import { classifyValue } from "../secrets/scan.js"
import type { MCPServer } from "../manifest/schema.js"
import type {
  RegistryArgument,
  RegistryPackage,
  RegistryServer,
  RegistryServerView,
} from "./types.js"

/**
 * Маппинг записи MCP Registry в конфиг OpenCode V2.
 *
 * Правила:
 * - секреты никогда не копируются: значения с `isSecret`/похожие на токен
 *   превращаются в `{env:VAR}` (V2 подставляет env до парсинга JSONC);
 * - версия пакета фиксируется в команде, а не «latest»;
 * - поддерживаемые типы: npm, pypi, oci, cargo, remotes. mcpb/nuget требуют
 *   ручной настройки — честная ошибка, а не догадка.
 */

const PACKAGE_PRIORITY = ["npm", "pypi", "oci", "cargo"] as const

const SUPPORTED_PACKAGE_TYPES = new Set<string>(PACKAGE_PRIORITY)

export interface RegistryDraftOptions {
  /** имя MCP-сервера в манифесте; по умолчанию — последний сегмент registry-name */
  name?: string
  remote?: boolean
  /** явный тип пакета: npm|pypi|oci|cargo */
  packageType?: string
}

export interface RegistryDraft {
  name: string
  server: MCPServer
  transport: "remote" | "local"
  registryName: string
  registryVersion: string
  repository?: string
  /** переменные окружения, на которые ссылается сгенерированная запись */
  requiredEnv: string[]
  warnings: string[]
}

/** Имя MCP в манифесте: буквы, цифры, _ . - (как в схеме). */
export function sanitizeMcpName(registryName: string): string {
  const last = registryName.split("/").pop() ?? registryName
  const cleaned = last
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned === "" ? "mcp" : cleaned
}

export function assertMcpName(name: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new HarnessError(
      `Недопустимое имя MCP-сервера: "${name}"`,
      "разрешены буквы, цифры, _ . - — задай другое имя через --name",
    )
  }
}

/** Значение аргумента: реестр допускает строку или объект { value }. */
function scalarString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object" && value !== null && "value" in value) {
    const nested = (value as { value: unknown }).value
    if (typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean") {
      return String(nested)
    }
  }
  return undefined
}

/** Аргумент не должен нести плейнтекст-секрет: такой MCP настраивается вручную. */
function assertSafeArgument(value: string): void {
  if (classifyValue(undefined, value) === undefined) return
  throw new HarnessError(
    "Реестр передал в аргументах значение, похожее на секрет",
    "автоматически не добавляю: настрой MCP вручную и используй {env:VAR}",
  )
}

function argumentValues(args: readonly RegistryArgument[], warnings: string[]): string[] {
  const values: string[] = []
  for (const argument of args) {
    const value = scalarString(argument.value)
    if (value !== undefined) assertSafeArgument(value)
    if (argument.type === "named") {
      if (argument.name === undefined) {
        warnings.push("аргумент named без имени пропущен")
        continue
      }
      values.push(argument.name)
      if (value !== undefined && value !== "") values.push(value)
      continue
    }
    if (value === undefined) {
      if (argument.valueHint !== undefined) warnings.push(`аргумент "${argument.valueHint}" пропущен`)
      continue
    }
    values.push(value)
  }
  return values
}

function envVarName(raw: string | undefined, fallback: string): string {
  const source = raw ?? fallback
  const normalized = source
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
  return normalized === "" ? "MCP_TOKEN" : normalized
}

/** Первый placeholder `{name}` в шаблоне значения. */
function placeholderName(value: string | undefined): string | undefined {
  const match = value === undefined ? null : /\{([^{}]+)\}/.exec(value)
  return match?.[1]
}

/**
 * Значение секретного заголовка: сохраняем схему (`Bearer`), подставляем env.
 * Сам шаблон из реестра может содержать имя переменной — используем его.
 */
function secretHeaderValue(value: string | undefined, headerName: string): { value: string; env: string } {
  const env = envVarName(placeholderName(value), headerName)
  if (value === undefined) return { value: `{env:${env}}`, env }
  const withEnv = value.replace(/\{[^{}]+\}/g, `{env:${env}}`)
  if (withEnv.includes("{env:")) return { value: withEnv, env }
  /* Плейнтекст-токен без placeholder: схему авторизации сохраняем, значение — нет */
  const scheme = /^(Bearer|Basic|Token)\s+/i.exec(value)?.[1]
  return { value: scheme === undefined ? `{env:${env}}` : `${scheme} {env:${env}}`, env }
}

function selectPackage(server: RegistryServer, packageType: string | undefined): RegistryPackage | undefined {
  if (packageType !== undefined) {
    return server.packages.find((item) => item.registryType === packageType)
  }
  for (const type of PACKAGE_PRIORITY) {
    const found = server.packages.find((item) => item.registryType === type)
    if (found !== undefined) return found
  }
  return undefined
}

/** Пакет → команда запуска с запиненной версией. */
export function packageCommand(
  server: RegistryServer,
  pkg: RegistryPackage,
  warnings: string[],
): string[] {
  const version = pkg.version ?? server.version
  if (version === "" || version === "latest") {
    warnings.push("реестр не зафиксировал версию — команда будет использовать latest; запинь версию вручную")
  }
  const runtime = argumentValues(pkg.runtimeArguments, warnings)
  const args = argumentValues(pkg.packageArguments, warnings)

  switch (pkg.registryType) {
    case "npm":
      return [pkg.runtimeHint ?? "npx", ...runtime, `${pkg.identifier}@${version}`, ...args]
    case "pypi":
      return [pkg.runtimeHint ?? "uvx", ...runtime, `${pkg.identifier}==${version}`, ...args]
    case "oci": {
      const hasTag = /:[^/]+$/.test(pkg.identifier)
      const image = hasTag || version === "" ? pkg.identifier : `${pkg.identifier}:${version}`
      const dockerArgs = runtime.length > 0 ? runtime : ["run", "-i", "--rm"]
      return [pkg.runtimeHint ?? "docker", ...dockerArgs, image, ...args]
    }
    case "cargo": {
      const binary = pkg.runtimeHint ?? pkg.identifier.split("/").pop() ?? pkg.identifier
      warnings.push(`cargo-пакет требует установки: cargo install ${pkg.identifier}`)
      return [binary, ...runtime, ...args]
    }
    default:
      throw new HarnessError(
        `Тип пакета "${pkg.registryType}" не поддерживается автоматически`,
        "используй --remote или --package npm|pypi|oci|cargo; для mcpb/nuget настрой MCP вручную",
      )
  }
}

function environmentFor(
  pkg: RegistryPackage,
  requiredEnv: string[],
  warnings: string[],
): Record<string, string> {
  const environment: Record<string, string> = {}
  const optional: string[] = []
  for (const variable of pkg.environmentVariables) {
    const secretLike =
      variable.isSecret === true ||
      (variable.default !== undefined && classifyValue(variable.name, variable.default) !== undefined)
    if (secretLike) {
      environment[variable.name] = `{env:${variable.name}}`
      requiredEnv.push(variable.name)
      continue
    }
    if (variable.default !== undefined) {
      environment[variable.name] = variable.default
      continue
    }
    if (variable.isRequired === true) {
      environment[variable.name] = `{env:${variable.name}}`
      requiredEnv.push(variable.name)
      continue
    }
    optional.push(variable.name)
  }
  if (optional.length > 0) {
    warnings.push(`необязательные переменные не заданы: ${optional.join(", ")}`)
  }
  return environment
}

function remoteDraft(
  server: RegistryServer,
  warnings: string[],
  requiredEnv: string[],
): MCPServer {
  const remote = server.remotes[0]
  if (remote === undefined) {
    throw new HarnessError(`У сервера "${server.name}" нет remote-транспорта`, "используй --package <type>")
  }
  if (remote.type === "sse") {
    warnings.push("сервер использует SSE — проверь поддержку транспорта в своей версии OpenCode")
  }
  if (classifyValue("url", remote.url) !== undefined) {
    throw new HarnessError(
      "URL remote-сервера содержит учётные данные",
      "автоматически не добавляю: настрой MCP вручную с {env:VAR}",
    )
  }
  const headers: Record<string, string> = {}
  for (const header of remote.headers) {
    const looksSecret = header.isSecret === true || (header.value !== undefined && classifyValue(header.name, header.value) !== undefined)
    if (looksSecret) {
      const secret = secretHeaderValue(header.value, header.name)
      headers[header.name] = secret.value
      requiredEnv.push(secret.env)
      continue
    }
    if (header.value !== undefined) {
      headers[header.name] = header.value
      continue
    }
    if (header.isRequired === true) {
      const env = envVarName(undefined, header.name)
      headers[header.name] = `{env:${env}}`
      requiredEnv.push(env)
    }
  }
  return {
    type: "remote",
    url: remote.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  }
}

/** Единственная точка маппинга registry-записи в запись манифеста. */
export function draftFromRegistry(
  server: RegistryServer,
  options: RegistryDraftOptions = {},
): RegistryDraft {
  const name = options.name ?? sanitizeMcpName(server.name)
  assertMcpName(name)
  const warnings: string[] = []
  const requiredEnv: string[] = []

  if (server.status === "deprecated") {
    warnings.push("сервер помечен deprecated в реестре")
  }
  if (server.remotes.length > 0 && server.packages.length === 0 && options.packageType !== undefined) {
    throw new HarnessError(
      `У сервера "${server.name}" нет пакетов — доступен только remote`,
      "убери --package или выбери другой сервер",
    )
  }
  if (options.remote === true && options.packageType !== undefined) {
    throw new HarnessError("--remote и --package взаимоисключающи")
  }

  const wantRemote = options.remote === true || (options.packageType === undefined && server.remotes.length > 0)
  if (wantRemote) {
    const draft = remoteDraft(server, warnings, requiredEnv)
    return {
      name,
      server: draft,
      transport: "remote",
      registryName: server.name,
      registryVersion: server.version,
      ...(server.repository === undefined ? {} : { repository: server.repository }),
      requiredEnv: [...new Set(requiredEnv)],
      warnings,
    }
  }

  const pkg = selectPackage(server, options.packageType)
  if (pkg === undefined) {
    const types = server.packages.map((item) => item.registryType)
    throw new HarnessError(
      options.packageType !== undefined
        ? `У сервера "${server.name}" нет пакета "${options.packageType}"`
        : `У сервера "${server.name}" нет поддерживаемого пакета`,
      types.length === 0 ? "доступен только remote: добавь --remote" : `доступны: ${types.join(", ")}`,
    )
  }
  if (!SUPPORTED_PACKAGE_TYPES.has(pkg.registryType)) {
    throw new HarnessError(
      `Тип пакета "${pkg.registryType}" не поддерживается автоматически`,
      "настрой MCP вручную или выбери --remote",
    )
  }

  const environment = environmentFor(pkg, requiredEnv, warnings)
  return {
    name,
    server: {
      type: "local",
      command: packageCommand(server, pkg, warnings),
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
    },
    transport: "local",
    registryName: server.name,
    registryVersion: server.version,
    ...(server.repository === undefined ? {} : { repository: server.repository }),
    requiredEnv: [...new Set(requiredEnv)],
    warnings,
  }
}

/** JSON-представление для `mcp search --json`: без заголовков/значений env. */
export function registryServerView(server: RegistryServer): RegistryServerView {
  return {
    name: server.name,
    ...(server.title === undefined ? {} : { title: server.title }),
    ...(server.description === undefined ? {} : { description: server.description }),
    version: server.version,
    status: server.status,
    ...(server.repository === undefined ? {} : { repository: server.repository }),
    remotes: server.remotes.map((remote) => ({ type: remote.type, url: remote.url })),
    packages: server.packages.map((pkg) => ({
      registryType: pkg.registryType,
      identifier: pkg.identifier,
      ...(pkg.version === undefined ? {} : { version: pkg.version }),
    })),
  }
}

export interface ServerSummary {
  /** например `remote https://…` или `npm pkg@1.2.3` */
  transport: string
  /** harness умеет сгенерировать запись автоматически */
  supported: boolean
}

export function summarizeTransport(server: RegistryServer): ServerSummary {
  if (server.remotes.length > 0) {
    const remote = server.remotes[0] as (typeof server.remotes)[number]
    return { transport: `remote ${remote.url}`, supported: true }
  }
  const pkg = selectPackage(server, undefined) ?? server.packages[0]
  if (pkg === undefined) return { transport: "нет транспорта", supported: false }
  const version = pkg.version ?? server.version
  return {
    transport: `${pkg.registryType} ${pkg.identifier}@${version}`,
    supported: SUPPORTED_PACKAGE_TYPES.has(pkg.registryType),
  }
}
