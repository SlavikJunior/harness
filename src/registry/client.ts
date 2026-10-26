import { HarnessError } from "../core/errors.js"
import { DEFAULT_TTL_MS, describeAge, readCache, writeCache } from "./cache.js"
import { parseSearchResponse, parseServerResponse } from "./schema.js"
import type { RegistryServer } from "./types.js"

/**
 * Клиент официального MCP Registry (API v0.1).
 *
 * Инварианты:
 * - сеть не на критическом пути plan/apply — только явные `mcp search|add`;
 * - при недоступности сети отдаётся stale-кэш с предупреждением;
 * - `search` в API не документирован, поэтому результат всегда фильтруется
 *   на клиенте, а при ошибке параметра выполняется постраничная загрузка;
 * - значения заголовков/env никогда не печатаются и не логируются.
 */

export const REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io"
export const HARNESS_VERSION = "0.1.0"

const PAGE_SIZE = 100
const MAX_PAGES = 3
const FETCH_TIMEOUT_MS = 30_000

export type CacheSource = "network" | "cache" | "stale-cache"

export interface RegistrySearchResult {
  servers: RegistryServer[]
  source: CacheSource
  fetchedAt: string
  /** предупреждение для пользователя (stale-кэш, смена схемы) */
  warning?: string
}

export interface RegistryServerResult {
  server: RegistryServer
  source: CacheSource
  fetchedAt: string
  warning?: string
}

export interface RegistryClientOptions {
  /** override для тестов и корпоративных зеркал */
  baseUrl?: string
  refresh?: boolean
  ttlMs?: number
  now?: () => number
  fetchImpl?: typeof fetch
  cacheRoot?: string
  userAgent?: string
}

export interface RegistryClient {
  search(query: string): Promise<RegistrySearchResult>
  get(name: string, version?: string): Promise<RegistryServerResult>
}

class RegistryHttpError extends HarnessError {
  readonly status: number

  constructor(status: number, statusText: string) {
    super(
      `MCP Registry ответил ${status}${statusText === "" ? "" : ` ${statusText}`}`,
      status === 404 ? "проверь имя сервера: harness mcp search <query>" : "повтори позже или используй --refresh",
    )
    this.status = status
  }
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

function cacheKeySearch(query: string): string {
  return `search:${normalizeQuery(query)}:${PAGE_SIZE * MAX_PAGES}`
}

function cacheKeyServer(name: string, version: string | undefined): string {
  return `server:${name}:${version ?? "latest"}`
}

function warningForStale(ageMs: number): string {
  return `реестр недоступен — использую кэш ${describeAge(ageMs)} назад`
}

/** Числовое сравнение версий: 1.10.0 > 1.9.0. */
export function compareVersions(left: string, right: string): number {
  const split = (value: string): (string | number)[] =>
    value.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index]
    const y = b[index]
    if (x === y) continue
    /* semver: prerelease-хвост меньше релиза, числовой хвост — больше */
    if (x === undefined) return typeof y === "number" ? -1 : 1
    if (y === undefined) return typeof x === "number" ? 1 : -1
    if (typeof x === "number" && typeof y === "number") return x - y
    return String(x).localeCompare(String(y))
  }
  return 0
}

function dedupeLatest(servers: readonly RegistryServer[]): RegistryServer[] {
  const byName = new Map<string, RegistryServer>()
  for (const server of servers) {
    if (server.status === "deleted") continue
    const current = byName.get(server.name)
    if (current === undefined) {
      byName.set(server.name, server)
      continue
    }
    if (server.isLatest && !current.isLatest) {
      byName.set(server.name, server)
      continue
    }
    if (server.isLatest === current.isLatest && compareVersions(server.version, current.version) > 0) {
      byName.set(server.name, server)
    }
  }
  return [...byName.values()]
}

/** Клиентская фильтрация — страховка на случай, если `search` игнорируется API. */
function matchesQuery(server: RegistryServer, query: string): boolean {
  if (query === "") return true
  const haystack = `${server.name} ${server.title ?? ""} ${server.description ?? ""}`.toLowerCase()
  return query
    .split(/\s+/)
    .filter((token) => token !== "")
    .every((token) => haystack.includes(token))
}

function relevance(server: RegistryServer, query: string): number {
  const name = server.name.toLowerCase()
  if (name.endsWith(`/${query}`)) return 0
  if (name.includes(query)) return 1
  if ((server.title ?? "").toLowerCase().includes(query)) return 2
  return 3
}

function sortServers(servers: RegistryServer[], query: string): RegistryServer[] {
  return servers.toSorted((left, right) => {
    const byRelevance = relevance(left, query) - relevance(right, query)
    if (byRelevance !== 0) return byRelevance
    return left.name.localeCompare(right.name)
  })
}

export function createRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const baseUrl = (options.baseUrl ?? process.env.HARNESS_REGISTRY_URL ?? REGISTRY_BASE_URL).replace(/\/+$/, "")
  const now = options.now ?? Date.now
  const doFetch = options.fetchImpl ?? fetch
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const userAgent = options.userAgent ?? `harness-ctl/${HARNESS_VERSION}`

  async function getJson(url: string): Promise<unknown> {
    let response: Response
    try {
      response = await doFetch(url, {
        headers: { Accept: "application/json", "User-Agent": userAgent },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError"
      const detail = timeout
        ? `таймаут запроса (${FETCH_TIMEOUT_MS / 1000} с)`
        : error instanceof Error
          ? error.message
          : String(error)
      throw new HarnessError(
        `MCP Registry недоступен: ${detail}`,
        "проверь сеть; каталог — opt-in команда, plan/apply от него не зависят",
      )
    }
    if (!response.ok) throw new RegistryHttpError(response.status, response.statusText)
    try {
      return (await response.json()) as unknown
    } catch {
      throw new HarnessError(
        "MCP Registry вернул не-JSON ответ",
        "реестр в preview: повтори позже или проверь обновление harness",
      )
    }
  }

  async function fetchPages(query: string, withSearch: boolean): Promise<{ servers: RegistryServer[]; invalid: number }> {
    const servers: RegistryServer[] = []
    let invalid = 0
    let cursor: string | undefined
    let pages = 0
    do {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (withSearch && query !== "") params.set("search", query)
      if (cursor !== undefined) params.set("cursor", cursor)
      const parsed = parseSearchResponse(await getJson(`${baseUrl}/v0.1/servers?${params.toString()}`))
      for (const entry of parsed.entries) servers.push(entry.server)
      invalid += parsed.invalid
      cursor = parsed.nextCursor
      pages += 1
    } while (cursor !== undefined && pages < MAX_PAGES)
    return { servers, invalid }
  }

  async function loadSearch(
    query: string,
  ): Promise<{ servers: RegistryServer[]; source: CacheSource; fetchedAt: string; warning?: string }> {
    const key = cacheKeySearch(query)
    const cached = await readCache<RegistryServer[]>(key, { root: options.cacheRoot, ttlMs, now })
    if (options.refresh !== true && cached?.fresh === true) {
      return { servers: cached.data, source: "cache", fetchedAt: cached.fetchedAt }
    }

    let fetched: { servers: RegistryServer[]; invalid: number }
    try {
      fetched = await fetchPages(query, true)
    } catch (error) {
      /* Неудачный `search` (недокументированный параметр) → полная загрузка */
      if (error instanceof RegistryHttpError && error.status >= 400 && error.status < 500 && query !== "") {
        fetched = await fetchPages(query, false)
      } else {
        throw error
      }
    }

    const filtered = sortServers(
      dedupeLatest(fetched.servers)
        .filter((server) => server.remotes.length > 0 || server.packages.length > 0)
        .filter((server) => matchesQuery(server, normalizeQuery(query))),
      normalizeQuery(query),
    )
    await writeCache(key, filtered, { root: options.cacheRoot, now })
    const schemaWarning =
      fetched.invalid > 0 && fetched.servers.length > 0 && filtered.length === 0
        ? "часть ответов реестра не распознана — возможно, сменилась схема"
        : undefined
    return {
      servers: filtered,
      source: "network",
      fetchedAt: new Date(now()).toISOString(),
      ...(schemaWarning === undefined ? {} : { warning: schemaWarning }),
    }
  }

  async function search(query: string): Promise<RegistrySearchResult> {
    try {
      const loaded = await loadSearch(query)
      return {
        servers: loaded.servers,
        source: loaded.source,
        fetchedAt: loaded.fetchedAt,
        ...(loaded.warning === undefined ? {} : { warning: loaded.warning }),
      }
    } catch (error) {
      const cached = await readCache<RegistryServer[]>(cacheKeySearch(query), {
        root: options.cacheRoot,
        ttlMs,
        now,
      })
      if (cached !== undefined) {
        return {
          servers: cached.data,
          source: "stale-cache",
          fetchedAt: cached.fetchedAt,
          warning: warningForStale(cached.ageMs),
        }
      }
      throw error
    }
  }

  async function get(name: string, version?: string): Promise<RegistryServerResult> {
    const key = cacheKeyServer(name, version)
    const cached = await readCache<RegistryServer>(key, { root: options.cacheRoot, ttlMs, now })
    if (options.refresh !== true && cached?.fresh === true) {
      return { server: cached.data, source: "cache", fetchedAt: cached.fetchedAt }
    }
    const encodedName = encodeURIComponent(name)
    const encodedVersion = encodeURIComponent(version ?? "latest")
    let raw: unknown
    try {
      raw = await getJson(`${baseUrl}/v0.1/servers/${encodedName}/versions/${encodedVersion}`)
    } catch (error) {
      if (cached !== undefined) {
        return {
          server: cached.data,
          source: "stale-cache",
          fetchedAt: cached.fetchedAt,
          warning: warningForStale(cached.ageMs),
        }
      }
      throw error
    }
    const entry = parseServerResponse(raw)
    if (entry.server.status === "deleted") {
      throw new HarnessError(
        `MCP-сервер "${name}" удалён из реестра`,
        "выбери другой сервер: harness mcp search <query>",
      )
    }
    await writeCache(key, entry.server, { root: options.cacheRoot, now })
    const warning =
      entry.server.status === "deprecated"
        ? `сервер помечен deprecated${entry.server.updatedAt === undefined ? "" : ` (${entry.server.updatedAt})`}`
        : undefined
    return {
      server: entry.server,
      source: "network",
      fetchedAt: new Date(now()).toISOString(),
      ...(warning === undefined ? {} : { warning }),
    }
  }

  return { search, get }
}
