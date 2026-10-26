import { parseDocument, type Document } from "yaml"
import { HarnessError } from "../core/errors.js"
import { readText, writeTextAtomic } from "../core/fs.js"
import { MANIFEST_PATH, validateManifestText } from "../manifest/load.js"
import type { Manifest } from "../manifest/schema.js"
import { scopeFrom, type ScopeInput } from "../scope.js"

/**
 * Точечная правка манифеста с сохранением комментариев.
 *
 * Общая часть для `add skill|mcp` и `mcp add`: правка валидируется до записи,
 * поэтому сломанный YAML не попадёт на диск. `editManifestText` нужен для
 * `--dry-run` — тот же результат, но без записи.
 */

export interface ManifestEditResult {
  manifest: Manifest
  text: string
  file: string
}

/** Добавленные коллекции — в блочном стиле (draft-манифест использует flow []/{}). */
function normalizeFlow(doc: Document): void {
  for (const key of ["skills", "mcp"]) {
    const node = doc.get(key)
    if (node !== null && node !== undefined && typeof node === "object" && "flow" in node) {
      ;(node as { flow?: boolean }).flow = false
    }
  }
}

export async function editManifestText(
  input: ScopeInput,
  edit: (doc: Document) => void,
): Promise<ManifestEditResult> {
  const scope = scopeFrom(input)
  const file = MANIFEST_PATH(scope)
  const text = await readText(file)
  if (text === undefined) {
    throw new HarnessError(
      `Манифест не найден: ${file}`,
      `Сначала: harness${scope.kind === "global" ? " --global" : ""} init`,
    )
  }
  const doc = parseDocument(text)
  edit(doc)
  normalizeFlow(doc)
  const nextText = doc.toString()
  const manifest = validateManifestText(nextText) // защита от поломки манифеста своей же правкой
  return { manifest, text: nextText, file }
}

export async function editManifest(
  input: ScopeInput,
  edit: (doc: Document) => void,
): Promise<Manifest> {
  const result = await editManifestText(input, edit)
  await writeTextAtomic(result.file, result.text)
  return result.manifest
}
