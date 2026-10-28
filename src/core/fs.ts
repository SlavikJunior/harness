import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

/** Тонкая обвязка над node:fs/promises — только то, что реально нужно. */

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** Чтение текстового файла целиком. Возвращает undefined, если файла нет. */
export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

/** Чтение с ограничением размера — для маркерных файлов стека. */
export async function readTextCapped(file: string, maxBytes = 1_000_000): Promise<string | undefined> {
  try {
    const stat = await fs.stat(file)
    if (stat.size > maxBytes) return undefined
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Атомарная запись: сначала temp-файл, затем rename.
 * Гарантирует, что читатель не увидит мирутый файл.
 */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  const mode = await fs.stat(file).then((stat) => stat.mode & 0o777).catch(() => undefined)
  await fs.writeFile(temp, text, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) })
  if (mode !== undefined) await fs.chmod(temp, mode)
  await fs.rename(temp, file)
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * Стабильный хеш содержимого директории: рекурсивно по файлам,
 * сумма хешей (path + sha256(content)) с сортировкой. Пустая директория
 * и отсутствующая считаются разными (префикс).
 */
export async function sha256Dir(dir: string): Promise<string> {
  if (!(await isDirectory(dir))) return sha256("missing|")
  const parts: string[] = []
  const walk = async (current: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(target, relPath)
      else if (entry.isFile()) {
        const hash = sha256(await fs.readFile(target))
        parts.push(`${relPath}:${hash}`)
      }
    }
  }
  await walk(dir, "")
  return sha256(`present|${parts.join("|")}`)
}

/** Рекурсивное удаление директории, если существует. */
export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

/** Рекурсивное копирование директории (замена целевой целиком). */
export async function copyDir(from: string, to: string): Promise<void> {
  await removeDir(to)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(from, to, { recursive: true })
}
