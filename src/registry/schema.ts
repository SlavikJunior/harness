import { z } from "zod"
import { HarnessError } from "../core/errors.js"
import type {
  RegistryArgument,
  RegistryEnvVar,
  RegistryHeader,
  RegistryPackage,
  RegistryRemote,
  RegistryServer,
  RegistryStatus,
} from "./types.js"

/**
 * Схемы ответов MCP Registry. Все объекты — `passthrough`: реестр
 * развивается, неизвестные поля не должны ломать поиск.
 */

const argumentSchema = z
  .object({
    type: z.string().optional(),
    name: z.string().optional(),
    value: z.unknown().optional(),
    valueHint: z.string().optional(),
    isRequired: z.boolean().optional(),
  })
  .passthrough()

const envVarSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    default: z.string().optional(),
  })
  .passthrough()

const headerSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    value: z.string().optional(),
  })
  .passthrough()

const packageSchema = z
  .object({
    registryType: z.string().min(1),
    registryBaseUrl: z.string().optional(),
    identifier: z.string().min(1),
    version: z.string().optional(),
    runtimeHint: z.string().optional(),
    transport: z.object({ type: z.string().optional() }).passthrough().optional(),
    runtimeArguments: z.array(argumentSchema).optional(),
    packageArguments: z.array(argumentSchema).optional(),
    environmentVariables: z.array(envVarSchema).optional(),
  })
  .passthrough()

const remoteSchema = z
  .object({
    type: z.string().min(1),
    url: z.string().min(1),
    headers: z.array(headerSchema).optional(),
  })
  .passthrough()

const officialMetaSchema = z
  .object({
    "io.modelcontextprotocol.registry/official": z
      .object({
        status: z.string().optional(),
        isLatest: z.boolean().optional(),
        updatedAt: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const serverDetailSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string().min(1),
    repository: z.object({ url: z.string().optional() }).passthrough().optional(),
    websiteUrl: z.string().optional(),
    packages: z.array(packageSchema).optional(),
    remotes: z.array(remoteSchema).optional(),
  })
  .passthrough()

export const registryEntrySchema = z
  .object({
    server: serverDetailSchema,
    _meta: officialMetaSchema.optional(),
  })
  .passthrough()

export const searchResponseSchema = z
  .object({
    servers: z.array(z.unknown()),
    metadata: z.object({ nextCursor: z.string().nullable().optional() }).passthrough().optional(),
  })
  .passthrough()

function toStatus(raw: string | undefined): RegistryStatus {
  return raw === "deprecated" || raw === "deleted" ? raw : "active"
}

function toPackage(value: z.infer<typeof packageSchema>): RegistryPackage {
  return {
    registryType: value.registryType.toLowerCase(),
    ...(value.registryBaseUrl === undefined ? {} : { registryBaseUrl: value.registryBaseUrl }),
    identifier: value.identifier,
    ...(value.version === undefined ? {} : { version: value.version }),
    ...(value.runtimeHint === undefined ? {} : { runtimeHint: value.runtimeHint }),
    ...(value.transport?.type === undefined ? {} : { transport: value.transport.type }),
    runtimeArguments: (value.runtimeArguments ?? []).map(toArgument),
    packageArguments: (value.packageArguments ?? []).map(toArgument),
    environmentVariables: (value.environmentVariables ?? []).map(toEnvVar),
  }
}

function toArgument(value: z.infer<typeof argumentSchema>): RegistryArgument {
  return {
    type: value.type,
    name: value.name,
    value: value.value,
    valueHint: value.valueHint,
    isRequired: value.isRequired,
  }
}

function toEnvVar(value: z.infer<typeof envVarSchema>): RegistryEnvVar {
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.isRequired === undefined ? {} : { isRequired: value.isRequired }),
    ...(value.isSecret === undefined ? {} : { isSecret: value.isSecret }),
    ...(value.default === undefined ? {} : { default: value.default }),
  }
}

function toHeader(value: z.infer<typeof headerSchema>): RegistryHeader {
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.isRequired === undefined ? {} : { isRequired: value.isRequired }),
    ...(value.isSecret === undefined ? {} : { isSecret: value.isSecret }),
    ...(value.value === undefined ? {} : { value: value.value }),
  }
}

function toRemote(value: z.infer<typeof remoteSchema>): RegistryRemote {
  return {
    type: value.type,
    url: value.url,
    headers: (value.headers ?? []).map(toHeader),
  }
}

export interface ParsedEntry {
  server: RegistryServer
  /** исходный `$schema` server.json — для диагностики смены версии */
  schemaUrl?: string
}

/** Нормализация одной записи; undefined — запись не соответствует схеме. */
export function normalizeEntry(raw: unknown): ParsedEntry | undefined {
  const parsed = registryEntrySchema.safeParse(raw)
  if (!parsed.success) return undefined
  const entry = parsed.data
  const official = entry._meta?.["io.modelcontextprotocol.registry/official"]
  const detail = entry.server
  return {
    server: {
      name: detail.name,
      ...(detail.title === undefined ? {} : { title: detail.title }),
      ...(detail.description === undefined ? {} : { description: detail.description }),
      version: detail.version,
      status: toStatus(official?.status),
      isLatest: official?.isLatest === true,
      ...(official?.updatedAt === undefined ? {} : { updatedAt: official.updatedAt }),
      ...(detail.repository?.url === undefined ? {} : { repository: detail.repository.url }),
      ...(detail.websiteUrl === undefined ? {} : { websiteUrl: detail.websiteUrl }),
      packages: (detail.packages ?? []).map(toPackage),
      remotes: (detail.remotes ?? []).map(toRemote),
    },
    ...(typeof (detail as unknown as { $schema?: unknown }).$schema === "string"
      ? { schemaUrl: (detail as unknown as { $schema: string }).$schema }
      : {}),
  }
}

export interface ParsedSearchResponse {
  entries: ParsedEntry[]
  nextCursor?: string
  /** сколько записей пришло, но не прошло схему */
  invalid: number
}

export function parseSearchResponse(raw: unknown): ParsedSearchResponse {
  const parsed = searchResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HarnessError(
      "Неожиданный ответ MCP Registry",
      "реестр в статусе preview: возможно, сменилась схема ответа — проверь обновление harness",
    )
  }
  const entries: ParsedEntry[] = []
  let invalid = 0
  for (const item of parsed.data.servers) {
    const entry = normalizeEntry(item)
    if (entry === undefined) invalid += 1
    else entries.push(entry)
  }
  return {
    entries,
    ...(typeof parsed.data.metadata?.nextCursor === "string"
      ? { nextCursor: parsed.data.metadata.nextCursor }
      : {}),
    invalid,
  }
}

export function parseServerResponse(raw: unknown): ParsedEntry {
  const entry = normalizeEntry(raw)
  if (entry === undefined) {
    throw new HarnessError(
      "MCP Registry вернул сервер неизвестного формата",
      "проверь обновление harness: схема реестра могла измениться",
    )
  }
  return entry
}
