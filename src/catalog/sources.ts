import os from "node:os"
import path from "node:path"
import { parse } from "yaml"
import { z } from "zod"
import { HarnessError } from "../core/errors.js"
import { readText } from "../core/fs.js"
import type { SourceDef, SourcesFile } from "./types.js"

/** Определение источников: файл пользователя + встроенные дефолты. */

const sourceDefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("repo"), url: z.string().min(1) }).strict(),
  z.object({ type: z.literal("local"), path: z.string().min(1) }).strict(),
])
const sourcesFileSchema = z
  .object({ sources: z.record(z.string().min(1), sourceDefSchema) })
  .strict()

const DEFAULT_SOURCES: Record<string, SourceDef> = {
  "android-skills": { type: "repo", url: "https://github.com/android/skills.git" },
  alexgladkov: { type: "repo", url: "https://github.com/AlexGladkov/skills.git" },
  "gradle-skills": { type: "repo", url: "https://github.com/gradle/gradle-skills.git" },
}

export function sourcesFile(): string {
  const base =
    process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ""
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config")
  return path.join(base, "harness", "sources.yaml")
}

export function validateSourcesText(text: string, file: string): Record<string, SourceDef> {
  const checked = sourcesFileSchema.safeParse(parse(text))
  if (!checked.success) {
    const detail = checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    throw new HarnessError(`Некорректный ${file}: ${detail}`)
  }
  return checked.data.sources
}

/** Итоговое множество источников: встроенные дефолты, поверх — файл пользователя. */
export async function loadSources(): Promise<SourcesFile> {
  const file = sourcesFile()
  const text = await readText(file)
  if (text === undefined) return { sources: { ...DEFAULT_SOURCES } }
  const user = validateSourcesText(text, file)
  return { sources: { ...DEFAULT_SOURCES, ...user } }
}
