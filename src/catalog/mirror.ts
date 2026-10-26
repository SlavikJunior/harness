import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import { HarnessError } from "../core/errors.js"
import { isDirectory } from "../core/fs.js"
import { run, runChecked } from "../core/exec.js"
import type { SourceDef } from "./types.js"

/**
 * Зеркала источников скиллов.
 *
 * repo-источник клонируется (shallow) в XDG data dir; перед клоном ищется
 * существующий клон с тем же remote (например ручной git clone в
 * ~/.config/opencode/skills/*) и переиспользуется вместо переклонирования.
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

/**
 * Гарантирует наличие актуального зеркала источника.
 * refresh — обновить shallow-клон (git pull --ff-only).
 */
export async function ensureMirror(
  sourceId: string,
  def: SourceDef,
  options: { refresh?: boolean } = {},
): Promise<Mirror> {
  if (def.type === "local") {
    const dir = path.resolve(def.path === "~" || def.path.startsWith("~/")
      ? path.join(os.homedir(), def.path.slice(1))
      : def.path)
    if (!(await isDirectory(dir))) {
      throw new HarnessError(`local-источник "${sourceId}" не найден: ${dir}`, "Проверь путь в sources.yaml")
    }
    return { dir, ref: dir, reused: true }
  }

  const mirrorDir = path.join(mirrorsRoot(), sourceId)
  let dir: string
  let reused = false
  if (await isDirectory(path.join(mirrorDir, ".git"))) {
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

  if (options.refresh === true) await pull(dir, sourceId)
  const ref = await gitHead(dir)
  if (ref === undefined) {
    throw new HarnessError(`Зеркало "${sourceId}": не удалось определить HEAD (${dir})`)
  }
  return { dir, ref, reused }
}
