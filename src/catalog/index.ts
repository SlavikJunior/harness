import { ensureMirror } from "./mirror.js"
import { scanMirror } from "./scan.js"
import { loadSources } from "./sources.js"
import type { CatalogIndex, SkillItem, SourceDef } from "./types.js"

export type { SkillItem, SourceDef, SourcesFile, CatalogIndex } from "./types.js"
export { sourcesFile, loadSources, validateSourcesText } from "./sources.js"
export { parseFrontmatter, scanMirror } from "./scan.js"
export { ensureMirror, mirrorsRoot } from "./mirror.js"

/**
 * Построение индекса каталога: зеркало каждого источника + скан SKILL.md.
 * sourceFilter — оставить только указанные источники.
 */
export async function buildCatalog(options: { refresh?: boolean; sourceFilter?: string[] } = {}): Promise<CatalogIndex> {
  const sources = await loadSources()
  const selected: [string, SourceDef][] = Object.entries(sources.sources).filter(
    ([id]) => options.sourceFilter === undefined || options.sourceFilter.includes(id),
  )

  const skills: SkillItem[] = []
  const mounted: Record<string, { dir: string; ref: string }> = {}
  for (const [id, def] of selected) {
    const mirror = await ensureMirror(id, def, { refresh: options.refresh })
    mounted[id] = { dir: mirror.dir, ref: mirror.ref }
    const found = await scanMirror(mirror.dir, id, mirror.ref)
    skills.push(...found)
  }
  skills.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
  return { sources: sources.sources, skills }
}
