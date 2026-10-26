import path from "node:path"
import { promises as fs } from "node:fs"
import { parse } from "yaml"
import type { SkillItem } from "./types.js"

/**
 * Сканер зеркала: рекурсивный BFS за SKILL.md — универсален для любого
 * layout (плоского, группового `<категория>/<скилл>`, одиночного в корне),
 * повторяет семантику OpenCode skill-scan (глубина ≤ 6, скип скрытых).
 */

const MAX_DEPTH = 6
const IGNORED: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".gradle",
  "coverage",
  "vendor",
])

export interface SkillFrontmatter {
  name: string | undefined
  description: string | undefined
}

/** Разбор frontmatter SKILL.md: блок между первой парой `---`. */
export function parseFrontmatter(text: string): SkillFrontmatter {
  /* Windows: git с core.autocrlf=true отдаёт скиллы с CRLF — режем оба варианта */
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return { name: undefined, description: undefined }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) return { name: undefined, description: undefined }
  const block = lines.slice(1, end).join("\n")
  let parsed: unknown
  try {
    parsed = parse(block)
  } catch {
    /* битый frontmatter — скилл остаётся, имя берётся из директории */
    return { name: undefined, description: undefined }
  }
  if (typeof parsed !== "object" || parsed === null) return { name: undefined, description: undefined }
  const map = parsed as Record<string, unknown>
  return {
    name: typeof map.name === "string" && map.name.length > 0 ? map.name : undefined,
    description: typeof map.description === "string" ? map.description : undefined,
  }
}

/** Скан директории зеркала → список скиллов. */
export async function scanMirror(
  root: string,
  sourceId: string,
  sourceRef: string,
  pin?: string,
): Promise<SkillItem[]> {
  const found: { dir: string; relDir: string }[] = []
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: "", depth: 0 }]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined || visited.has(item.dir)) continue
    visited.add(item.dir)
    const entries = await fs.readdir(item.dir, { withFileTypes: true }).catch(() => [])
    const children = entries.filter(
      (entry) =>
        !entry.name.startsWith(".") &&
        !IGNORED.has(entry.name) &&
        (entry.isDirectory() || entry.isFile()),
    )
    const skillFile = children.find((child) => child.isFile() && child.name === "SKILL.md")
    if (skillFile !== undefined) {
      found.push({ dir: item.dir, relDir: item.rel })
      continue
    }
    if (item.depth >= MAX_DEPTH) continue
    for (const child of children) {
      if (!child.isDirectory()) continue
      queue.push({
        dir: path.join(item.dir, child.name),
        rel: item.rel === "" ? child.name : `${item.rel}/${child.name}`,
        depth: item.depth + 1,
      })
    }
  }

  const skills: SkillItem[] = []
  for (const skill of found) {
    const text = await fs.readFile(path.join(skill.dir, "SKILL.md"), "utf8").catch(() => undefined)
    const frontmatter = text === undefined ? { name: undefined, description: undefined } : parseFrontmatter(text)
    const dirName = path.basename(skill.dir)
    skills.push({
      source: sourceId,
      name: frontmatter.name ?? dirName,
      description: frontmatter.description,
      dir: skill.dir,
      relDir: skill.relDir === "" ? dirName : skill.relDir,
      ref: sourceRef,
      ...(pin === undefined ? {} : { pin }),
    })
  }
  return skills.toSorted((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
}
