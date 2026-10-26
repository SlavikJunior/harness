import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import { HarnessError } from "../core/errors.js"
import { isDirectory, sha256 } from "../core/fs.js"
import { run, runChecked } from "../core/exec.js"
import type { SourceDef } from "./types.js"

/**
 * Зеркала источников скиллов.
 *
 * repo-источник клонируется (shallow) в XDG data dir; перед клоном ищется
 * существующий клон с тем же remote (например ручной git clone в
 * ~/.config/opencode/skills/*) и переиспользуется вместо переклонирования.
 *
 * Pin: каждый ref (тег/ветка/sha) живёт в отдельном зеркале `<id>@<ref>-<hash>` —
 * одному зеркалу нельзя одновременно соответствовать разным ref, а проекты
 * могут пинить разные версии одного источника.
 */

export function mirrorsRoot(): string {
  const base =
    process.env.XDG_DATA_HOME !== undefined && process.env.XDG_DATA_HOME !== ""
      ? process.env.XDG_DATA_HOME
      : path.join(os.homedir(), ".local", "share")
  return path.join(base, "harness", "mirrors")
}

export interface Mirror {
  /** абсолютный путь к корню зеркала */
  dir: string
  /** git SHA или путь (для local-источников) */
  ref: string
  /** зеркало — переиспользованный ручной клон */
  reused: boolean
}

/** Имя директории зеркала для ref: читаемое + короткий хеш от полного ref. */
export function pinnedMirrorDir(sourceId: string, ref: string): string {
  const readable = ref.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40)
  return path.join(mirrorsRoot(), `${sourceId}@${readable}-${sha256(ref).slice(0, 8)}`)
}

async function gitRemote(dir: string): Promise<string | undefined> {
  const result = await run("git", ["-C", dir, "config", "--get", "remote.origin.url"])
  return result.code === 0 ? result.stdout.trim() || undefined : undefined
}

async function gitHead(dir: string): Promise<string | undefined> {
  const result = await run("git", ["-C", dir, "rev-parse", "HEAD"])
  return result.code === 0 ? result.stdout.trim() || undefined : undefined
}

/** Директории, где могли остаться ручные клоны скиллов OpenCode. */
async function reuseCandidateDirs(): Promise<string[]> {
  const base =
    process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ""
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config")
  const opencodeSkills = path.join(base, "opencode", "skills")
  try {
    const entries = await fs.readdir(opencodeSkills, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(opencodeSkills, entry.name))
  } catch {
    return [] /* директории нет — кандидатов нет */
  }
}

/** Поиск существующего клона с нужным remote. */
async function findExistingClone(url: string): Promise<Mirror | undefined> {
  for (const dir of await reuseCandidateDirs()) {
    if (!(await isDirectory(path.join(dir, ".git")))) continue
    const remote = await gitRemote(dir)
    if (remote !== url) continue
    const ref = await gitHead(dir)
    if (ref !== undefined) return { dir, ref, reused: true }
  }
  return undefined
}

async function pull(dir: string, sourceId: string): Promise<void> {
  const result = await run("git", ["-C", dir, "pull", "--ff-only", "origin", "HEAD"])
  if (result.code !== 0) {
    throw new HarnessError(
      `Не удалось обновить зеркало "${sourceId}" (${dir})`,
      result.stderr.trim() || "проверь сеть и состояние клона",
    )
  }
}

/** Клон/обновление зеркала на конкретный ref (тег, ветка или sha). */
async function fetchPinned(dir: string, url: string, ref: string, sourceId: string): Promise<void> {
  if (!(await isDirectory(path.join(dir, ".git")))) {
    await runChecked("git", ["init", "-q", dir])
    await runChecked("git", ["-C", dir, "remote", "add", "origin", url])
  } else {
    /* URL источника мог измениться в sources.yaml — зеркало остаётся валидным */
    await runChecked("git", ["-C", dir, "remote", "set-url", "origin", url])
  }

  const fetched = await run("git", ["-C", dir, "fetch", "--depth", "1", "origin", ref])
  if (fetched.code !== 0) {
    throw new HarnessError(
      `Не удалось получить ref "${ref}" источника "${sourceId}"`,
      fetched.stderr.trim() || "проверь, что тег/ветка/sha существует в репозитории",
    )
  }
  await runChecked("git", ["-C", dir, "checkout", "--detach", "-q", "FETCH_HEAD"])
}

/**
 * Гарантирует наличие актуального зеркала источника.
 * refresh — обновить shallow-клон (git pull --ff-only или fetch нужного ref).
 * ref — зафиксировать тег/ветку/sha (только для repo-источников).
 */
export async function ensureMirror(
  sourceId: string,
  def: SourceDef,
  options: { refresh?: boolean; ref?: string } = {},
): Promise<Mirror> {
  if (def.type === "local") {
    if (options.ref !== undefined) {
      throw new HarnessError(
        `local-источник "${sourceId}" не поддерживает ref="${options.ref}"`,
        "ref работает только для repo-источников: тег, ветка или sha git",
      )
    }
    const dir = path.resolve(def.path === "~" || def.path.startsWith("~/")
      ? path.join(os.homedir(), def.path.slice(1))
      : def.path)
    if (!(await isDirectory(dir))) {
      throw new HarnessError(`local-источник "${sourceId}" не найден: ${dir}`, "Проверь путь в sources.yaml")
    }
    return { dir, ref: dir, reused: true }
  }

  const pinned = options.ref !== undefined
  const mirrorDir = pinned ? pinnedMirrorDir(sourceId, options.ref as string) : path.join(mirrorsRoot(), sourceId)
  let dir: string
  let reused = false

  if (pinned) {
    const ref = options.ref as string
    const hasHead = (await isDirectory(path.join(mirrorDir, ".git"))) && (await gitHead(mirrorDir)) !== undefined
    if (!hasHead) {
      try {
        await fetchPinned(mirrorDir, def.url, ref, sourceId)
      } catch (error) {
        /* недокачанный клон не должен блокировать повторную попытку */
        await fs.rm(mirrorDir, { recursive: true, force: true })
        throw error
      }
    } else if (options.refresh === true) {
      await fetchPinned(mirrorDir, def.url, ref, sourceId)
    }
    dir = mirrorDir
  } else if (await isDirectory(path.join(mirrorDir, ".git"))) {
    dir = mirrorDir
  } else {
    const reusedClone = await findExistingClone(def.url)
    if (reusedClone !== undefined) {
      dir = reusedClone.dir
      reused = true
    } else {
      await runChecked("git", ["clone", "--depth", "1", def.url, mirrorDir])
      dir = mirrorDir
    }
  }

  if (options.refresh === true && !pinned) await pull(dir, sourceId)
  const ref = await gitHead(dir)
  if (ref === undefined) {
    throw new HarnessError(
      `Зеркало "${sourceId}": не удалось определить HEAD (${dir})`,
      "удали директорию зеркала и повтори команду",
    )
  }
  return { dir, ref, reused }
}
