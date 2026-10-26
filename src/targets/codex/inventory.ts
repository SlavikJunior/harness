import { promises as fs } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { pathExists, readText } from "../../core/fs.js"
import { deepEqual } from "../../core/hash.js"
import { instructionsFilePath, type InstructionBlock } from "../../apply/instructions.js"
import { buildCatalog } from "../../catalog/index.js"
import { buildDesiredState, catalogRefs } from "../../apply/desired.js"
import { validateManifestText } from "../../manifest/load.js"
import { agentDefinitionSchema, mcpServerSchema, type Manifest, type MCPServer } from "../../manifest/schema.js"
import type { Scope } from "../../scope.js"
import { valueAt } from "../../apply/config.js"
import type { CodexItem, CodexDesired, CodexDesiredAgent, CodexDesiredSkill } from "./types.js"
import type { CodexPaths } from "./paths.js"

/**
 * Инвентаризация Codex-экспорта.
 *
 * Источник правды — `harness.yaml`, но для миграции «всё, что реально есть
 * в OpenCode» дополнительно сканируются установленные скиллы, агенты и
 * MCP-серверы. Явно лишние (live-only) элементы помечаются в отчёте; их
 * можно отключить флагом --manifest-only.
 */

export interface InventoryOptions {
  /** не добавлять live-only артефакты, только манифест */
  manifestOnly?: boolean
}

export interface InventoryResult {
  desired: CodexDesired
  manifest?: Manifest
}

/** Манифест может отсутствовать — тогда переносим фактические артефакты OpenCode. */
export async function readManifestOptional(scope: Scope): Promise<Manifest | undefined> {
  const text = await readText(scope.manifestFile)
  if (text === undefined) return undefined
  return validateManifestText(text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseAgentFile(text: string): { definition?: ReturnType<typeof agentDefinitionSchema.parse>; warning?: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  if (lines[0]?.trim() !== "---") return { warning: "нет frontmatter" }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) return { warning: "frontmatter не закрыт" }
  let frontmatter: unknown
  try {
    frontmatter = parseYaml(lines.slice(1, end).join("\n"))
  } catch {
    return { warning: "frontmatter не парсится как YAML" }
  }
  if (!isRecord(frontmatter)) return { warning: "frontmatter не объект" }
  const body = lines.slice(end + 1).join("\n").trim()
  const candidate = {
    ...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
    ...(frontmatter.mode === "primary" || frontmatter.mode === "subagent" || frontmatter.mode === "all"
      ? { mode: frontmatter.mode }
      : {}),
    ...(typeof frontmatter.model === "string" ? { model: frontmatter.model } : {}),
    ...(Array.isArray(frontmatter.permissions) ? { permissions: frontmatter.permissions } : {}),
    ...(body === "" ? {} : { body }),
  }
  const parsed = agentDefinitionSchema.safeParse(candidate)
  if (!parsed.success) return { warning: `агент не прошёл схему: ${parsed.error.issues[0]?.message ?? "ошибка"}` }
  return { definition: parsed.data }
}

export async function inventoryCodex(
  scope: Scope,
  paths: CodexPaths,
  options: InventoryOptions = {},
): Promise<InventoryResult> {
  const manifest = await readManifestOptional(scope)
  const items: CodexItem[] = []
  const skills: CodexDesiredSkill[] = []
  const agents: CodexDesiredAgent[] = []
  const mcp: Record<string, MCPServer> = { ...(manifest?.mcp ?? {}) }
  const mcpOrigins: Record<string, "manifest" | "live"> = Object.fromEntries(
    Object.keys(manifest?.mcp ?? {}).map((name) => [name, "manifest"]),
  )

  /* Манифест: скиллы через каталог (ref/пин уже разрешены) */
  if (manifest !== undefined && (manifest.skills ?? []).length > 0) {
    const refs = catalogRefs(manifest)
    const catalog = await buildCatalog({ refs, sourceFilter: Object.keys(refs) })
    const desired = buildDesiredState(scope, manifest, catalog)
    for (const skill of desired.skills) {
      skills.push({
        name: skill.installName,
        sourceDir: skill.sourceDir,
        mode: skill.entry.mode ?? "vendor",
        origin: "manifest",
        ...(skill.entry.ref === undefined ? {} : { ref: skill.entry.ref }),
      })
    }
  }

  /* Манифест: агенты */
  for (const [name, definition] of Object.entries(manifest?.agents ?? {})) {
    agents.push({ name, definition, origin: "manifest" })
  }

  /* Live-only скиллы */
  if (options.manifestOnly !== true) {
    const knownSkills = new Set(skills.map((skill) => skill.name))
    const entries = await fs.readdir(scope.skillsDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith(".") || knownSkills.has(entry.name)) continue
      const target = path.join(scope.skillsDir, entry.name)
      if (!(await pathExists(path.join(target, "SKILL.md")))) continue
      const stat = await fs.lstat(target).catch(() => undefined)
      if (stat === undefined) continue
      let sourceDir = target
      let mode: "vendor" | "reference" = "vendor"
      if (stat.isSymbolicLink()) {
        const resolved = await fs.realpath(target).catch(() => undefined)
        if (resolved === undefined) {
          items.push({ section: "skills", name: entry.name, status: "skipped", message: "битая reference-ссылка" })
          continue
        }
        sourceDir = resolved
        mode = "reference"
      } else if (!(await fs.stat(target).then((value) => value.isDirectory()).catch(() => false))) {
        continue
      }
      skills.push({ name: entry.name, sourceDir, mode, origin: "live" })
    }

    /* Live-only агенты */
    const knownAgents = new Set(agents.map((agent) => agent.name))
    const agentFiles = await fs.readdir(scope.agentsDir, { withFileTypes: true }).catch(() => [])
    for (const file of agentFiles) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue
      const name = file.name.slice(0, -3)
      if (knownAgents.has(name)) continue
      const text = await readText(path.join(scope.agentsDir, file.name))
      if (text === undefined) continue
      const parsed = parseAgentFile(text)
      if (parsed.definition === undefined) {
        items.push({
          section: "agents",
          name,
          status: "skipped",
          message: `не удалось прочитать: ${parsed.warning ?? "неизвестная ошибка"}`,
        })
        continue
      }
      agents.push({ name, definition: parsed.definition, origin: "live" })
    }

    /* Live MCP: manifest wins, live-only добавляем */
    const configText = await readText(scope.configFile)
    const liveServers = valueAt(configText, ["mcp", "servers"])
    if (isRecord(liveServers)) {
      for (const [name, raw] of Object.entries(liveServers)) {
        const parsed = mcpServerSchema.safeParse(raw)
        if (!parsed.success) {
          items.push({
            section: "mcp",
            name,
            status: "skipped",
            message: "MCP в OpenCode-конфиге не соответствует схеме harness",
          })
          continue
        }
        const declared = mcp[name]
        if (declared === undefined) {
          mcp[name] = parsed.data
          mcpOrigins[name] = "live"
        } else if (!deepEqual(declared, parsed.data)) {
          items.push({
            section: "mcp",
            name,
            status: "approximate",
            message: "в OpenCode-конфиге отличается от манифеста; использован манифест",
          })
        }
      }
    }
  }

  const instructionFile = manifest?.instructions?.file ?? "AGENTS.md"
  const sourceFile = instructionsFilePath(scope, instructionFile)
  const sourceText = await readText(sourceFile)
  const targetFile = paths.instructionsFile
  const blocks: InstructionBlock[] = Object.entries(manifest?.instructions?.blocks ?? {}).map(
    ([name, content]): InstructionBlock => ({ name, content }),
  )
  const targetExists = await pathExists(targetFile)
  /* Если файл уже есть — управляем блоками (даже если это тот же AGENTS.md,
     что у OpenCode: экспорт должен догонять изменения манифеста).
     Полная копия — только когда целевого файла ещё нет. */
  const mode = targetExists
    ? "managed"
    : sourceText !== undefined && options.manifestOnly !== true
      ? "copy"
      : blocks.length > 0
        ? "managed"
        : "none"

  const configKeys = new Set<string>(Object.keys(manifest?.config ?? {}))
  const handledKeys = new Set(["mcp", "permissions", "policies", "agent", "agents", "instructions", "skills", "$schema"])
  const configText = await readText(scope.configFile)
  if (configText !== undefined) {
    const errors: ParseError[] = []
    const parsed = parseJsonc(configText, errors, { allowTrailingComma: true })
    if (errors.length === 0 && isRecord(parsed)) {
      for (const key of Object.keys(parsed)) {
        if (!handledKeys.has(key)) configKeys.add(key)
      }
    }
  }

  const desired: CodexDesired = {
    skills,
    agents,
    mcp,
    mcpOrigins,
    instructions: {
      mode,
      targetFile,
      ...(sourceText === undefined ? {} : { sourceFile, sourceText }),
      blocks,
    },
    items,
    configKeys: [...configKeys].toSorted(),
  }

  if (manifest === undefined) {
    desired.items.push({
      section: "config",
      name: "harness.yaml",
      status: "skipped",
      message: "манифест не найден — перенесены только фактические артефакты OpenCode",
    })
  }
  if (manifest?.permissions !== undefined) {
    desired.items.push({
      section: "config",
      name: "permissions",
      status: "skipped",
      message: "не переносится 1:1: настрой approval_policy/sandbox_mode/rules в Codex вручную",
    })
  }
  if (manifest?.policies !== undefined) {
    desired.items.push({
      section: "config",
      name: "policies",
      status: "skipped",
      message: "не переносится 1:1: используй Codex rules (prefix_rule) или sandbox",
    })
  }

  return { manifest, desired }
}

/** Проверка, что исходный скилл существует и содержит SKILL.md. */
export async function assertSkillSource(skill: CodexDesiredSkill): Promise<string | undefined> {
  const file = path.join(skill.sourceDir, "SKILL.md")
  const text = await readText(file)
  if (text === undefined) return `в источнике нет SKILL.md: ${skill.sourceDir}`
  if (text.trim() === "") return `пустой SKILL.md: ${skill.sourceDir}`
  return undefined
}

