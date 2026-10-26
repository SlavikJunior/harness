import { z } from "zod"

/**
 * Схема манифеста `harness.yaml` — единственный source of truth
 * желаемого состояния OpenCode-харнесса проекта. Strict: опечатки в полях — ошибка.
 */

export const skillModeSchema = z.enum(["vendor", "reference"])
export type SkillMode = z.infer<typeof skillModeSchema>

export const skillEntrySchema = z
  .object({
    /** id источника из sources.yaml */
    source: z.string().min(1),
    /** имя скилла (frontmatter `name` в SKILL.md) */
    name: z.string().min(1),
    /** vendor — копия в .opencode/skills/; reference — symlink в зеркало (default: vendor) */
    mode: skillModeSchema.optional(),
  })
  .strict()
export type SkillEntry = z.infer<typeof skillEntrySchema>

export const mcpLocalSchema = z
  .object({
    type: z.literal("local"),
    /** команда запуска, например ["bunx", "@playwright/mcp"] */
    command: z.array(z.string().min(1)).min(1),
    /** env для процесса сервера; секреты только через {env:VAR} */
    environment: z.record(z.string(), z.string()).optional(),
  })
  .strict()
export type MCPLocal = z.infer<typeof mcpLocalSchema>

export const mcpRemoteSchema = z
  .object({
    type: z.literal("remote"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict()
export type MCPRemote = z.infer<typeof mcpRemoteSchema>

export const mcpServerSchema = z.discriminatedUnion("type", [mcpLocalSchema, mcpRemoteSchema])
export type MCPServer = z.infer<typeof mcpServerSchema>

const mcpNameSchema = z.string().regex(/^[a-zA-Z0-9_.-]+$/, "имя сервера: буквы, цифры, _ . -")

export const manifestSchema = z
  .object({
    version: z.literal(1),
    skills: z.array(skillEntrySchema).optional(),
    mcp: z.record(mcpNameSchema, mcpServerSchema).optional(),
    /** passthrough: значения пишутся как top-level поля .opencode/opencode.jsonc */
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
export type Manifest = z.infer<typeof manifestSchema>

export const reservedConfigKeys = ["skills", "mcp", "permissions", "policies"] as const
