import { ensureMirror } from "./mirror.js"
import { scanMirror } from "./scan.js"
import { loadSources } from "./sources.js"
import type { CatalogIndex, SkillItem, SourceDef } from "./types.js"

export type { SkillItem, SourceDef, SourcesFile, CatalogIndex } from "./types.js"
export { sourcesFile, loadSources, validateSourcesText } from "./sources.js"
export { parseFrontmatter, scanMirror } from "./scan.js"
export { ensureMirror, mirrorsRoot, pinnedMirrorDir } from "./mirror.js"

/**
 * Построение индекса каталога: зеркала источников + скан SKILL.md.
 *
 * refs — какие refs источника нужны манифесту: `undefined` = HEAD,
 * строка = пин (тег/ветка/sha). Для каждого ref создаётся своё зеркало.
 * sourceFilter — оставить только указанные источники (тесты, адресный вызов).
 */
export async function buildCatalog(
  options: {
    refresh?: boolean
    sourceFilter?: string[]
    refs?: Record<string, (string | undefined)[]>
  } = {},
): Promise<CatalogIndex> {
  const sources = await loadSources()
  const selected: [string, SourceDef][] = Object.entries(sources.sources).filter(
    ([id]) => options.sourceFilter === undefined || options.sourceFilter.includes(id),
  )

  const skills: SkillItem[] = []
  for (const [id, def] of selected) {
    const requested = options.refs?.[id] ?? [undefined]
    const refs = [...new Set(requested)]
    for (const pin of refs) {
      const mirror = await ensureMirror(id, def, { refresh: options.refresh, ref: pin })
      skills.push(...(await scanMirror(mirror.dir, id, mirror.ref, pin)))
    }
  }
  skills.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
  return { sources: sources.sources, skills }
}
