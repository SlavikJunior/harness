import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import { sha256 } from "../core/fs.js"

/**
 * Кэш ответов MCP Registry.
 *
 * Реестр — preview и рекомендует агрегаторам кэшировать данные: сеть не
 * должна быть на критическом пути plan/apply, а `mcp search` не должен
 * ходить в сеть на каждый вызов. Кэш живёт в XDG data dir и содержит
 * только публичные данные реестра (без пользовательских секретов).
 */

export const CACHE_VERSION = 1
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function registryCacheRoot(): string {
  const base =
    process.env.XDG_DATA_HOME !== undefined && process.env.XDG_DATA_HOME !== ""
      ? process.env.XDG_DATA_HOME
      : path.join(os.homedir(), ".local", "share")
  return path.join(base, "harness", "registry")
}

interface CacheFile<T> {
  version: number
  key: string
  fetchedAt: string
  data: T
}

export interface CacheHit<T> {
  data: T
  fetchedAt: string
  ageMs: number
  fresh: boolean
}

function cacheFile(root: string, key: string): string {
  return path.join(root, `${sha256(key).slice(0, 16)}.json`)
}

/** Чтение кэша: битый/чужой файл не роняет команду — считается промахом. */
export async function readCache<T>(
  key: string,
  options: { root?: string; ttlMs?: number; now?: () => number } = {},
): Promise<CacheHit<T> | undefined> {
  const root = options.root ?? registryCacheRoot()
  let raw: string
  try {
    raw = await fs.readFile(cacheFile(root, key), "utf8")
  } catch {
    return undefined
  }
  let parsed: CacheFile<T>
  try {
    parsed = JSON.parse(raw) as CacheFile<T>
  } catch {
    return undefined
  }
  if (parsed.version !== CACHE_VERSION || parsed.key !== key || typeof parsed.fetchedAt !== "string") {
    return undefined
  }
  const fetchedAtMs = Date.parse(parsed.fetchedAt)
  if (Number.isNaN(fetchedAtMs)) return undefined
  const ageMs = Math.max(0, (options.now ?? Date.now)() - fetchedAtMs)
  return {
    data: parsed.data,
    fetchedAt: parsed.fetchedAt,
    ageMs,
    fresh: ageMs <= (options.ttlMs ?? DEFAULT_TTL_MS),
  }
}

export async function writeCache<T>(
  key: string,
  data: T,
  options: { root?: string; now?: () => number } = {},
): Promise<string> {
  const root = options.root ?? registryCacheRoot()
  const file = cacheFile(root, key)
  const record: CacheFile<T> = {
    version: CACHE_VERSION,
    key,
    fetchedAt: new Date((options.now ?? Date.now)()).toISOString(),
    data,
  }
  await fs.mkdir(root, { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  await fs.rename(temp, file)
  return file
}

/** Возраст кэша человекочитаемо: для предупреждения о stale-данных. */
export function describeAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} ч`
  return `${Math.floor(hours / 24)} дн`
}
