import path from "node:path"
import { isDirectory, pathExists, readTextCapped } from "../core/fs.js"

/** Детекция стека проекта по маркерам — данные-правила + один обход ФС. */

export interface DetectedStack {
  id: string
  /** человеческое название */
  title: string
  /** какие маркеры сработали: имена файлов или описание контента */
  markers: string[]
}

export interface DetectResult {
  stacks: DetectedStack[]
}

interface StackRule {
  id: string
  title: string
  /** существование файлов/директорий относительно корня проекта */
  files?: string[]
  /** контентные пробы: файл → регулярки (достаточно одной) */
  content?: { file: string; any: RegExp[] }[]
}

const RULES: StackRule[] = [
  {
    id: "android",
    title: "Android",
    files: ["app/src/main/AndroidManifest.xml"],
    content: [
      { file: "settings.gradle.kts", any: [/com\.android\.(application|library|test)\b/] },
      { file: "build.gradle.kts", any: [/com\.android\.(application|library|test)\b/] },
      { file: "build.gradle", any: [/com\.android\.(application|library|test)\b/] },
    ],
  },
  {
    id: "kmp",
    title: "Kotlin Multiplatform",
    content: [
      { file: "build.gradle.kts", any: [/kotlin\s*\(\s*["']multiplatform["']\s*\)/, /multiplatform\s*\{/] },
      { file: "build.gradle", any: [/multiplatform|kotlin-multiplatform/] },
    ],
  },
  {
    id: "kotlin",
    title: "Kotlin",
    files: ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"],
  },
  {
    id: "node",
    title: "Node.js",
    files: ["package.json"],
  },
  {
    id: "typescript",
    title: "TypeScript",
    files: ["tsconfig.json"],
  },
  {
    id: "node-next",
    title: "Next.js",
    content: [{ file: "package.json", any: [/"next"\s*:/] }],
  },
  {
    id: "rust",
    title: "Rust",
    files: ["Cargo.toml"],
  },
  {
    id: "python",
    title: "Python",
    files: ["pyproject.toml", "requirements.txt", "setup.py"],
  },
  {
    id: "go",
    title: "Go",
    files: ["go.mod"],
  },
  {
    id: "flutter",
    title: "Flutter",
    files: ["pubspec.yaml"],
  },
  {
    id: "ios",
    title: "iOS",
    files: ["Package.swift"],
  },
]

/** Детект по корню проекта. */
export async function detectStacks(projectRoot: string): Promise<DetectResult> {
  const stacks: DetectedStack[] = []
  for (const rule of RULES) {
    const markers: string[] = []

    if (rule.files !== undefined) {
      for (const file of rule.files) {
        const target = path.join(projectRoot, file)
        if (await isDirectory(target)) markers.push(`${file}/`)
        else if (await pathExists(target)) markers.push(file)
      }
    }

    if (rule.content !== undefined) {
      for (const probe of rule.content) {
        if (markers.includes(`${probe.file} (контент)`)) continue
        const text = await readTextCapped(path.join(projectRoot, probe.file))
        if (text === undefined) continue
        if (probe.any.some((regex) => regex.test(text))) markers.push(`${probe.file} (контент)`)
      }
    }

    if (markers.length > 0) stacks.push({ id: rule.id, title: rule.title, markers })
  }
  return { stacks }
}
