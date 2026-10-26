/** Типы каталога: определение источников и записи скиллов. */

export type SourceDef =
  | { type: "repo"; url: string }
  | { type: "local"; path: string }

export interface SourcesFile {
  sources: Record<string, SourceDef>
}

export interface SkillItem {
  /** id источника */
  source: string
  /** имя из frontmatter `name` (fallback: имя директории) */
  name: string
  /** описание из frontmatter */
  description: string | undefined
  /** абсолютный путь к директории скилла (SKILL.md лежит прямо в ней) */
  dir: string
  /** под-путь от корня зеркала, для отображения */
  relDir: string
  /** ref зеркала (sha коммита для git, путь для local) */
  ref: string
  /** запрошенный pin (тег/ветка/sha) или undefined для HEAD */
  pin?: string
}

export interface CatalogIndex {
  sources: Record<string, SourceDef>
  skills: SkillItem[]
}
