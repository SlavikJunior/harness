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
    /** тег/ветка/sha для repo-источника: фиксирует версию скилла */
    ref: z.string().regex(/^\S+$/, "ref не должен содержать пробелов").optional(),
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

/**
 * Правило V2: `permissions: [{ action, resource, effect }]`.
 * Порядок значим (последнее совпадение побеждает), поэтому массив не сортируется.
 */
export const permissionEffectSchema = z.enum(["allow", "ask", "deny"])
export type PermissionEffect = z.infer<typeof permissionEffectSchema>

export const permissionRuleSchema = z
  .object({
    /** действие инструмента: read, edit, shell, webfetch, external_directory, <server>_<tool> … */
    action: z.string().min(1).regex(/^\S+$/, "action не должен содержать пробелов"),
    /** ресурс: путь, команда, URL, id скилла; `*` и `?` — wildcard */
    resource: z.string().min(1),
    effect: permissionEffectSchema,
  })
  .strict()
export type PermissionRule = z.infer<typeof permissionRuleSchema>

export const permissionsSchema = z.array(permissionRuleSchema)

/**
 * Policies V2 — жёсткий deny поверх permissions: политика может только
 * запретить, поэтому `allow`/`ask` в ней были бы ложным обещанием.
 */
export const policyRuleSchema = z
  .object({
    action: z.string().min(1).regex(/^\S+$/, "action не должен содержать пробелов"),
    resource: z.string().min(1),
    effect: z.literal("deny"),
  })
  .strict()
export type PolicyRule = z.infer<typeof policyRuleSchema>

export const policiesSchema = z.array(policyRuleSchema)

/** Имя агента: id = имя файла `.opencode/agents/<name>.md`. */
export const agentNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_.-]+$/, "имя агента: буквы, цифры, _ . -")

export const agentModeSchema = z.enum(["primary", "subagent", "all"])
export type AgentMode = z.infer<typeof agentModeSchema>

/**
 * Markdown-агент: frontmatter + body как system prompt.
 * Поддерживаются только поля, которые harness рендерит сам; остальное
 * (hidden, steps, color, request) — вне MVP, чтобы не имитировать полноту.
 */
export const agentDefinitionSchema = z
  .object({
    description: z.string().min(1).optional(),
    mode: agentModeSchema.optional(),
    model: z.string().min(1).optional(),
    permissions: permissionsSchema.optional(),
    body: z.string().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.description !== undefined ||
      value.mode !== undefined ||
      value.model !== undefined ||
      value.permissions !== undefined ||
      (value.body ?? "").trim() !== "",
    "агент пуст: укажи description/mode/model/permissions или body",
  )
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>

export const agentsSchema = z.record(agentNameSchema, agentDefinitionSchema)

/** Имя управляемого блока в AGENTS.md: входит в маркер `<!-- harness:begin:NAME -->`. */
export const instructionBlockNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+$/, "имя блока: буквы, цифры, _ . -")

const instructionBlockContentSchema = z
  .string()
  .refine((value) => value.trim() !== "", "блок не может быть пустым")
  .refine(
    (value) => !value.includes("<!-- harness:"),
    "в содержимом блока нельзя писать маркеры harness",
  )

const instructionsFileSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:/.test(value), "путь должен быть относительным")
  .refine(
    (value) => !value.split(/[\\/]/).some((segment) => segment === ".."),
    "путь не должен выходить за пределы проекта",
  )

export const instructionsSchema = z
  .object({
    /** файл инструкций относительно корня проекта (по умолчанию AGENTS.md) */
    file: instructionsFileSchema.optional(),
    /** управляемые блоки: имя → markdown; порядок в файле = порядок в манифесте */
    blocks: z.record(instructionBlockNameSchema, instructionBlockContentSchema),
  })
  .strict()
export type InstructionsConfig = z.infer<typeof instructionsSchema>

export const manifestSchema = z
  .object({
    version: z.literal(1),
    skills: z.array(skillEntrySchema).optional(),
    mcp: z.record(mcpNameSchema, mcpServerSchema).optional(),
    /** управляемые блоки AGENTS.md (или другого файла инструкций) */
    instructions: instructionsSchema.optional(),
    /** правила V2 для .opencode/opencode.jsonc → top-level `permissions` */
    permissions: permissionsSchema.optional(),
    /** политики V2: жёсткий deny поверх permissions (top-level `policies`) */
    policies: policiesSchema.optional(),
    /** markdown-агенты `.opencode/agents/<name>.md` */
    agents: agentsSchema.optional(),
    /** passthrough: значения пишутся как top-level поля .opencode/opencode.jsonc */
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
export type Manifest = z.infer<typeof manifestSchema>

export const reservedConfigKeys = ["skills", "mcp", "permissions", "policies", "agents"] as const
