import { promises as fs } from "node:fs"
import path from "node:path"
import { HarnessError } from "../core/errors.js"

/**
 * Ссылки reference-скиллов.
 *
 * POSIX: обычный symlink на директорию зеркала.
 * Windows: directory junction — не требует прав администратора/Developer Mode,
 * но работает только для локальных путей (не UNC) и требует NTFS. Если
 * junction недоступен, честно падаем с подсказкой про `mode: vendor`, а не
 * подменяем ссылку копией (иначе `update` перестал бы обновлять скилл).
 */

export type ReferenceLinkType = "dir" | "junction"

export function referenceLinkType(platform: NodeJS.Platform = process.platform): ReferenceLinkType {
  return platform === "win32" ? "junction" : "dir"
}

/** Windows может вернуть путь с NT-префиксом (`\\?\C:\…`, `\??\C:\…`). */
function stripWindowsPrefix(value: string): string {
  return value.replace(/^\\\\\?\\/, "").replace(/^\\\?\?\\/, "")
}

/**
 * Канонический вид цели ссылки для сравнения: абсолютный путь, `/` как
 * разделитель, без хвостового слэша; на Windows — без учёта регистра.
 */
export function normalizeLinkTarget(
  raw: string,
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const impl = platform === "win32" ? path.win32 : path.posix
  const value = platform === "win32" ? stripWindowsPrefix(raw) : raw
  const absolute = impl.isAbsolute(value) ? value : impl.resolve(impl.dirname(linkPath), value)
  const unified = absolute.replace(/\\/g, "/").replace(/\/+$/, "")
  return platform === "win32" ? unified.toLowerCase() : unified
}

/** Совпадает ли фактическая цель ссылки с ожидаемой директорией источника. */
export function sameLinkTarget(
  raw: string,
  linkPath: string,
  expected: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return normalizeLinkTarget(raw, linkPath, platform) === normalizeLinkTarget(expected, linkPath, platform)
}

/** Коды ошибок Windows, при которых junction/симлинк недоступен без прав. */
const WINDOWS_LINK_ERRORS = new Set(["EPERM", "EACCES", "UNKNOWN", "EINVAL", "ENOSYS"])

export function windowsLinkHint(code: string | undefined): string | undefined {
  if (code === undefined || !WINDOWS_LINK_ERRORS.has(code)) return undefined
  return (
    "на Windows включи Developer Mode (симлинки) или используй mode: vendor; " +
    "junction не работает для сетевых путей"
  )
}

/** Создание ссылки reference-скилла; на Windows — junction. */
export async function createReferenceLink(
  sourceDir: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    await fs.symlink(sourceDir, targetDir, referenceLinkType(platform))
  } catch (error) {
    const hint = platform === "win32" ? windowsLinkHint((error as NodeJS.ErrnoException).code) : undefined
    if (hint !== undefined) {
      throw new HarnessError(`Не удалось создать reference-ссылку: ${targetDir}`, hint)
    }
    throw error
  }
}
