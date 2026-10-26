import { loadManifest } from "../manifest/load.js"
import { catalogRefs } from "../apply/desired.js"
import { loadSources } from "../catalog/sources.js"
import { changedUpstreams, resolveUpstreamRefs, type UpstreamState } from "../catalog/upstream.js"
import { dim, info, warn } from "../core/log.js"
import type { Scope } from "../scope.js"
import { updateOnce } from "./update.js"

/**
 * `update --watch`: периодический опрос upstream и apply при изменениях.
 *
 * Это foreground-цикл без демона: Ctrl+C останавливает. Сеть опрашивается
 * только `git ls-remote`; тяжёлые объекты скачиваются лишь при реальном
 * изменении. Ошибка одного источника не останавливает watch.
 */

export interface WatchOptions {
  intervalMs?: number
  json?: boolean
  dryRun?: boolean
  signal?: AbortSignal
  /** для тестов: остановиться после N циклов */
  maxCycles?: number
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    signal?.addEventListener("abort", finish, { once: true })
  })
}

export async function watchUpdates(scope: Scope, options: WatchOptions = {}): Promise<void> {
  const intervalMs = Math.max(1000, options.intervalMs ?? 5 * 60_000)
  /* В NDJSON-режиме предупреждения идут в stderr, чтобы не ломать поток stdout */
  const reportWarning = options.json === true ? (message: string) => console.error(`⚠ ${message}`) : warn
  let previous: UpstreamState | undefined
  let cycles = 0

  do {
    try {
      const manifest = await loadManifest(scope)
      const refs = catalogRefs(manifest)
      const sources = (await loadSources()).sources
      const { resolved, errors } = await resolveUpstreamRefs(sources, refs)
      for (const [key, message] of Object.entries(errors)) {
        reportWarning(`${key}: ${message}`)
      }

      const changed = previous === undefined ? [] : changedUpstreams(previous, resolved)
      const firstCycle = previous === undefined
      previous = resolved

      if (firstCycle || changed.length > 0) {
        if (!options.json) {
          info(
            firstCycle
              ? "watch: первичная синхронизация"
              : `watch: изменения — ${changed.join(", ")}`,
          )
        }
        const report = await updateOnce(scope, { json: options.json === true, dryRun: options.dryRun })
        if (options.json) {
          console.log(
            JSON.stringify({
              at: new Date().toISOString(),
              firstCycle,
              changed,
              plan: report.plan,
              applied: report.applied,
              dryRun: report.dryRun,
            }),
          )
        }
      } else if (!options.json) {
        dim(`watch: без изменений (${new Date().toLocaleTimeString()})`)
      }
    } catch (error) {
      reportWarning(`watch: ${error instanceof Error ? error.message : String(error)}`)
    }

    cycles += 1
    if (options.maxCycles !== undefined && cycles >= options.maxCycles) break
    await sleep(intervalMs, options.signal)
  } while (options.signal?.aborted !== true)
}
