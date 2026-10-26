import os from "node:os"
import { sha256Dir } from "../core/fs.js"
import { run, type RunResult } from "../core/exec.js"
import type { SourceDef } from "./types.js"

/**
 * Опрос upstream-состояния зеркал для `update --watch`.
 *
 * `git ls-remote` дешёвый и не тянет объекты: сравниваем SHA на сервере
 * с прошлым опросом. Запиненные 40-символьные sha неизменяемы — сеть для
 * них не нужна. local-источники опрашиваются хешем директории.
 */

export type UpstreamState = Record<string, string>

export interface UpstreamResolution {
  resolved: UpstreamState
  errors: Record<string, string>
}

export type RunFn = (command: string, args: string[]) => Promise<RunResult>

/** Первая строка `git ls-remote`; для аннотированных тегов — peeled `^{}`. */
export function parseLsRemote(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const peeled = lines.find((line) => line.endsWith("^{}"))
  const chosen = peeled ?? lines[0]
  return chosen?.split(/\s+/)[0]
}

function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref)
}

export function upstreamKey(sourceId: string, ref: string | undefined): string {
  return `${sourceId}@${ref ?? "HEAD"}`
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/")
    ? `${os.homedir()}${value.slice(1)}`
    : value
}

/**
 * Текущие SHA всех repo-refs манифеста. Ошибки не роняют весь опрос:
 * недоступный источник попадает в errors, остальные продолжают работать.
 */
export async function resolveUpstreamRefs(
  sources: Record<string, SourceDef>,
  refs: Record<string, (string | undefined)[]>,
  options: { run?: RunFn } = {},
): Promise<UpstreamResolution> {
  const runner = options.run ?? run
  const resolved: UpstreamState = {}
  const errors: Record<string, string> = {}

  for (const [sourceId, wanted] of Object.entries(refs)) {
    const def = sources[sourceId]
    if (def === undefined) {
      errors[upstreamKey(sourceId, undefined)] = `источник "${sourceId}" не найден в sources.yaml`
      continue
    }
    for (const ref of new Set(wanted)) {
      const key = upstreamKey(sourceId, ref)
      if (def.type === "local") {
        if (ref !== undefined) {
          errors[key] = `local-источник "${sourceId}" не поддерживает ref`
          continue
        }
        try {
          resolved[key] = await sha256Dir(expandHome(def.path))
        } catch (error) {
          errors[key] = error instanceof Error ? error.message : String(error)
        }
        continue
      }
      if (ref !== undefined && isCommitSha(ref)) {
        resolved[key] = ref
        continue
      }
      const args =
        ref === undefined
          ? ["ls-remote", def.url, "HEAD"]
          : ["ls-remote", def.url, ref, `${ref}^{}`]
      const result = await runner("git", args)
      if (result.code !== 0) {
        errors[key] = result.stderr.trim() || `git ls-remote завершился с кодом ${result.code}`
        continue
      }
      const sha = parseLsRemote(result.stdout)
      if (sha === undefined) {
        errors[key] = `ref "${ref ?? "HEAD"}" не найден в ${def.url}`
        continue
      }
      resolved[key] = sha
    }
  }
  return { resolved, errors }
}

/** Ключи, которые изменились с прошлого опроса (включая новые/исчезнувшие). */
export function changedUpstreams(previous: UpstreamState, next: UpstreamState): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  return [...keys].filter((key) => previous[key] !== next[key]).toSorted()
}
