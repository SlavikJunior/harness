/**
 * Нормализованные типы официального MCP Registry (API v0.1).
 *
 * Реестр — preview-сервис: схема может меняться, поэтому парсер терпим
 * к неизвестным полям, а наружу отдаются только те данные, которые нужны
 * для поиска и генерации записи MCP-сервера.
 */

export type RegistryStatus = "active" | "deprecated" | "deleted"

export interface RegistryArgument {
  /** positional | named (в схеме реестра встречаются и другие значения) */
  type: string | undefined
  name: string | undefined
  /** строковое значение; объекты/числа приводятся к строке в маппинге */
  value: unknown
  valueHint: string | undefined
  isRequired: boolean | undefined
}

export interface RegistryEnvVar {
  name: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  default?: string
}

export interface RegistryHeader {
  name: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  /** значение-шаблон, например `Bearer {api_key}`; может отсутствовать */
  value?: string
}

export interface RegistryPackage {
  registryType: string
  registryBaseUrl?: string
  identifier: string
  version?: string
  runtimeHint?: string
  transport?: string
  runtimeArguments: RegistryArgument[]
  packageArguments: RegistryArgument[]
  environmentVariables: RegistryEnvVar[]
}

export interface RegistryRemote {
  /** streamable-http | sse | … */
  type: string
  url: string
  headers: RegistryHeader[]
}

export interface RegistryServer {
  name: string
  title?: string
  description?: string
  version: string
  status: RegistryStatus
  isLatest: boolean
  updatedAt?: string
  repository?: string
  websiteUrl?: string
  packages: RegistryPackage[]
  remotes: RegistryRemote[]
}

/** Компактное представление для `mcp search --json`: без заголовков и env. */
export interface RegistryServerView {
  name: string
  title?: string
  description?: string
  version: string
  status: RegistryStatus
  repository?: string
  remotes: { type: string; url: string }[]
  packages: { registryType: string; identifier: string; version?: string }[]
}
