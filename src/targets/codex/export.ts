import { promises as fs } from "node:fs"
import path from "node:path"
import { copyDir, pathExists, readText, sha256Dir, writeTextAtomic } from "../../core/fs.js"
import { deepEqual, stableStringify } from "../../core/hash.js"
import { classifyValue, maskText } from "../../secrets/scan.js"
import { sameLinkTarget, createReferenceLink } from "../../apply/link.js"
import {
  normalizeInstructionContent,
  parseInstructionBlocks,
  renderInstructionBlocks,
} from "../../apply/instructions.js"
import type { SkillMode } from "../../manifest/schema.js"
import type { Scope } from "../../scope.js"
import { mapAgent } from "./agents.js"
import { assertSkillSource, inventoryCodex } from "./inventory.js"
import { mapMcpServer } from "./mcp.js"
import { codexPaths, displayCodexPath, displayHomePath, type CodexEnvironment } from "./paths.js"
import { loadCodexState, hashText, hashValue, writeCodexState } from "./state.js"
import {
  applyMcpChanges,
  hasMcpServer,
  mcpServerValue,
  parseTomlText,
} from "./toml.js"
import type {
  CodexDesired,
  CodexExportResult,
  CodexItem,
  CodexState,
  CodexStatus,
} from "./types.js"
import { createCodexBackup } from "./backup.js"

/**
 * Codex export: OpenCode/harness → `.codex`/`.agents`.
 *
 * Экспорт односторонний: Codex-файлы генерируются, ручные правки в них
 * ловятся по hash и не перезаписываются без --force. OpenCode не меняется.
 */

export interface CodexExportOptions {
  dryRun?: boolean
  force?: boolean
  manifestOnly?: boolean
  environment?: CodexEnvironment
}

type CodexAction =
  | { kind: "write"; target: string; content: string }
  | { kind: "remove"; target: string }
  | { kind: "skill"; target: string; sourceDir: string; mode: SkillMode; name: string }

interface ExecutedAction {
  written?: string
  removed?: string
  actualSkillMode?: SkillMode
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value)
}

/** Codex хранит доверие проекта в user config: projects.<path>.trust_level. */
async function isProjectTrusted(scope: Scope, paths: ReturnType<typeof codexPaths>): Promise<boolean> {
  const text = await readText(paths.userConfigFile)
  if (text === undefined) return false
  try {
    const parsed = parseTomlText(text, paths.userConfigFile).value
    const projects = parsed.projects
    if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return false
    const entry = (projects as Record<string, unknown>)[path.resolve(scope.root)]
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false
    return (entry as Record<string, unknown>).trust_level === "trusted"
  } catch {
    return false
  }
}

async function lexists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

async function skillTargetMatchesState(target: string, entry: { mode: SkillMode; sourceDir: string; hash: string }): Promise<boolean> {
  if (entry.mode === "reference") {
    const stat = await fs.lstat(target).catch(() => undefined)
    if (stat?.isSymbolicLink() !== true) return false
    const link = await fs.readlink(target).catch(() => undefined)
    return link === undefined ? false : sameLinkTarget(link, target, entry.sourceDir)
  }
  return (await sha256Dir(target)) === entry.hash
}

function addItem(
  items: CodexItem[],
  section: CodexItem["section"],
  name: string,
  status: CodexStatus,
  message?: string,
  target?: string,
): void {
  const existing = items.find((item) => item.section === section && item.name === name)
  if (existing === undefined) {
    items.push({ section, name, status, ...(message === undefined ? {} : { message }), ...(target === undefined ? {} : { target }) })
    return
  }
  if (status === "conflict") existing.status = "conflict"
  else if (existing.status === "approximate" || status === "approximate") existing.status = "approximate"
  else if (status !== "unchanged") existing.status = status
  if (message !== undefined) existing.message = existing.message === undefined ? message : `${existing.message}; ${message}`
  if (target !== undefined) existing.target = target
}

function baseStatus(origin: "manifest" | "live", approximate: boolean): CodexStatus {
  if (origin === "live") return "approximate"
  return approximate ? "approximate" : "mapped"
}

function statusForWrite(
  items: CodexItem[],
  section: CodexItem["section"],
  name: string,
  origin: "manifest" | "live",
  approximate: boolean,
  message: string | undefined,
  action: "create" | "update" | "unchanged",
): CodexStatus {
  const status =
    action === "unchanged"
      ? approximate || origin === "live"
        ? "approximate"
        : "unchanged"
      : baseStatus(origin, approximate)
  addItem(
    items,
    section,
    name,
    status,
    message ?? (origin === "live" ? "взят из фактического OpenCode (нет в манифесте)" : undefined),
  )
  return status
}

function configMessage(key: string): string {
  if (key === "model" || key === "small_model") {
    return "ID моделей OpenCode и Codex различаются — задай model в Codex вручную"
  }
  if (key === "provider") return "Codex использует model_provider/model_providers — настрой вручную"
  if (key === "permission" || key === "permissions") {
    return "настрой approval_policy/sandbox_mode/rules в Codex вручную"
  }
  return "нет автоматического переноса в Codex — пропущено"
}

/* ---------- skills ---------- */

async function planSkills(
  scope: Scope,
  desired: CodexDesired,
  paths: ReturnType<typeof codexPaths>,
  state: CodexState,
  nextState: CodexState,
  items: CodexItem[],
  actions: CodexAction[],
  options: { force: boolean },
  environment: CodexEnvironment,
): Promise<void> {
  const wanted = new Set(desired.skills.map((skill) => skill.name))
  for (const skill of desired.skills) {
    if (!isSafeSegment(skill.name)) {
      addItem(items, "skills", skill.name, "skipped", "недопустимое имя директории скилла")
      continue
    }
    const sourceError = await assertSkillSource(skill)
    if (sourceError !== undefined) {
      addItem(items, "skills", skill.name, "skipped", sourceError)
      continue
    }
    const target = path.join(paths.skillsDir, skill.name)
    const sourceHash = await sha256Dir(skill.sourceDir)
    const previous = state.skills[skill.name]
    const exists = await lexists(target)
    let action: "create" | "update" | "unchanged" | "conflict" = "create"
    if (exists) {
      if (previous === undefined) action = "conflict"
      else if (!(await skillTargetMatchesState(target, previous))) action = "conflict"
      else if (previous.sourceDir === skill.sourceDir && previous.mode === skill.mode) {
        action = previous.mode === "reference" || previous.hash === sourceHash ? "unchanged" : "update"
      } else action = "update"
    }
    if (action === "conflict" && !options.force) {
      addItem(
        items,
        "skills",
        skill.name,
        "conflict",
        exists && previous === undefined
          ? "такой скилл уже есть в Codex и не принадлежит harness"
          : "скилл изменён вне harness — нужен --force",
        displayCodexPath(scope, target, environment),
      )
      continue
    }
    if (action === "conflict") {
      addItem(items, "skills", skill.name, "forced", "чужой/изменённый скилл перезаписан по --force")
      action = "update"
    } else {
      statusForWrite(items, "skills", skill.name, skill.origin, false, undefined, action)
    }
    if (action !== "unchanged") {
      actions.push({ kind: "skill", target, sourceDir: skill.sourceDir, mode: skill.mode, name: skill.name })
    }
    nextState.skills[skill.name] = {
      path: target,
      mode: skill.mode,
      sourceDir: skill.sourceDir,
      hash: sourceHash,
    }
  }

  for (const [name, entry] of Object.entries(state.skills)) {
    if (wanted.has(name)) continue
    const exists = await lexists(entry.path)
    if (!exists) {
      delete nextState.skills[name]
      continue
    }
    if (!(await skillTargetMatchesState(entry.path, entry)) && !options.force) {
      addItem(items, "skills", name, "conflict", "скилл изменён вне harness — удаление требует --force")
      continue
    }
    actions.push({ kind: "remove", target: entry.path })
    addItem(items, "skills", name, options.force ? "forced" : "mapped", "удалён из Codex: нет в OpenCode-манифесте")
    delete nextState.skills[name]
  }
}

/* ---------- agents ---------- */

async function planAgents(
  desired: CodexDesired,
  paths: ReturnType<typeof codexPaths>,
  state: CodexState,
  nextState: CodexState,
  items: CodexItem[],
  actions: CodexAction[],
  options: { force: boolean },
): Promise<void> {
  const wanted = new Set(desired.agents.map((agent) => agent.name))
  for (const agent of desired.agents) {
    if (!isSafeSegment(agent.name)) {
      addItem(items, "agents", agent.name, "skipped", "недопустимое имя агента")
      continue
    }
    const mapped = mapAgent(agent.name, agent.definition)
    if (mapped.content === undefined) {
      addItem(items, "agents", agent.name, "skipped", mapped.message ?? "агент пуст")
      continue
    }
    const target = path.join(paths.agentsDir, `${agent.name}.toml`)
    const previous = state.agents[agent.name]
    const current = await readText(target)
    const nextHash = hashText(mapped.content)
    let action: "create" | "update" | "unchanged" | "conflict" | "forced" = "create"
    if (current === undefined) action = "create"
    else if (current === mapped.content) action = "unchanged"
    else if (previous === undefined) action = "conflict"
    else if (hashText(current) !== previous.hash) action = "conflict"
    else if (nextHash === previous.hash) action = "unchanged"
    else action = "update"

    if (action === "conflict" && !options.force) {
      addItem(
        items,
        "agents",
        agent.name,
        "conflict",
        previous === undefined
          ? "агент уже есть в Codex и не принадлежит harness"
          : "агент изменён вне harness — нужен --force",
      )
      continue
    }
    if (action === "conflict") {
      addItem(items, "agents", agent.name, "forced", "чужой/изменённый агент перезаписан по --force")
      action = "update"
    } else {
      statusForWrite(
        items,
        "agents",
        agent.name,
        agent.origin,
        mapped.status === "approximate",
        mapped.message,
        action,
      )
    }
    if (action !== "unchanged") actions.push({ kind: "write", target, content: mapped.content })
    nextState.agents[agent.name] = { path: target, hash: nextHash }
  }

  for (const [name, entry] of Object.entries(state.agents)) {
    if (wanted.has(name)) continue
    const current = await readText(entry.path)
    if (current === undefined) {
      delete nextState.agents[name]
      continue
    }
    if (hashText(current) !== entry.hash && !options.force) {
      addItem(items, "agents", name, "conflict", "агент изменён вне harness — удаление требует --force")
      continue
    }
    actions.push({ kind: "remove", target: entry.path })
    addItem(items, "agents", name, options.force ? "forced" : "mapped", "удалён из Codex: нет в OpenCode-манифесте")
    delete nextState.agents[name]
  }
}

/* ---------- instructions ---------- */

function blockHashes(blocks: { name: string; content: string }[]): Record<string, string> {
  return Object.fromEntries(blocks.map((block) => [block.name, hashText(normalizeInstructionContent(block.content))]))
}

async function planInstructions(
  scope: Scope,
  desired: CodexDesired,
  state: CodexState,
  nextState: CodexState,
  items: CodexItem[],
  actions: CodexAction[],
  options: { force: boolean },
  environment: CodexEnvironment,
): Promise<void> {
  const instruction = desired.instructions
  const blocks = instruction.blocks.filter((block) => {
    if (classifyValue(block.name, block.content) === undefined) return true
    addItem(
      items,
      "instructions",
      block.name,
      "skipped",
      "блок инструкций похож на плейнтекст-секрет — не переношу автоматически",
    )
    return false
  })
  const target = instruction.targetFile
  const current = await readText(target)
  const targetDisplay = displayCodexPath(scope, target, environment)
  const override = path.join(path.dirname(target), "AGENTS.override.md")
  if (await pathExists(override)) {
    addItem(
      items,
      "instructions",
      "AGENTS.override.md",
      "approximate",
      "Codex предпочтёт AGENTS.override.md — managed-блоки в AGENTS.md могут не загрузиться",
    )
  }

  if (instruction.mode === "shared") {
    addItem(items, "instructions", "AGENTS.md", "mapped", "общий файл с OpenCode; копировать не нужно", targetDisplay)
    delete nextState.instructions
    return
  }

  if (instruction.mode === "none") {
    const previous = state.instructions
    if (previous !== undefined && current !== undefined) {
      if (previous.fullCopy) {
        if (hashText(current) === previous.hash || options.force) {
          actions.push({ kind: "remove", target })
          addItem(items, "instructions", "AGENTS.md", options.force ? "forced" : "mapped", "удалена копия инструкций", targetDisplay)
        } else {
          addItem(items, "instructions", "AGENTS.md", "conflict", "файл изменён вне harness — удаление требует --force")
        }
      } else {
        const removed = Object.keys(previous.blocks)
        const rendered = renderInstructionBlocks(current, [], removed)
        if (rendered.changed) {
          actions.push({ kind: "write", target, content: rendered.text })
          addItem(items, "instructions", "AGENTS.md", "mapped", "удалены managed-блоки", targetDisplay)
        } else {
          addItem(items, "instructions", "AGENTS.md", "unchanged", undefined, targetDisplay)
        }
      }
    } else {
      addItem(items, "instructions", "AGENTS.md", "unchanged", "инструкций для переноса нет", targetDisplay)
    }
    delete nextState.instructions
    return
  }

  if (instruction.mode === "copy") {
    if (instruction.sourceText === undefined) {
      addItem(items, "instructions", "AGENTS.md", "skipped", "исходный файл инструкций пуст или не найден")
      return
    }
    if (classifyValue(undefined, instruction.sourceText) !== undefined) {
      addItem(
        items,
        "instructions",
        "AGENTS.md",
        "skipped",
        "файл инструкций похож на плейнтекст-секрет — полную копию не делаю",
      )
      return
    }
    const content = instruction.sourceText.endsWith("\n") ? instruction.sourceText : `${instruction.sourceText}\n`
    if (Buffer.byteLength(content, "utf8") > 32 * 1024) {
      addItem(
        items,
        "instructions",
        "AGENTS.md",
        "approximate",
        "инструкции больше 32 KiB: Codex обрежет их без увеличения project_doc_max_bytes",
      )
    }
    actions.push({ kind: "write", target, content })
    addItem(items, "instructions", "AGENTS.md", "mapped", "полная копия инструкций OpenCode", targetDisplay)
    const copiedBlocks = parseInstructionBlocks(content)
    nextState.instructions = {
      file: target,
      fullCopy: true,
      hash: hashText(content),
      blocks: blockHashes([...copiedBlocks.blocks].map(([name, body]) => ({ name, content: body }))),
    }
    return
  }

  /* managed */
  const previous = state.instructions
  if (previous?.fullCopy === true && current !== undefined) {
    if (hashText(current) !== previous.hash && !options.force) {
      addItem(
        items,
        "instructions",
        "AGENTS.md",
        "conflict",
        "полная копия инструкций изменена вне harness — нужен --force",
        targetDisplay,
      )
      return
    }
    /* Пока манифест не добавил managed-блоки, полная копия остаётся копией
       и обновляется из OpenCode-файла — иначе миграция «замерзала» бы. */
    if (blocks.length === 0 && instruction.sourceText !== undefined) {
      const content = instruction.sourceText.endsWith("\n")
        ? instruction.sourceText
        : `${instruction.sourceText}\n`
      if (content !== current) {
        actions.push({ kind: "write", target, content })
        addItem(items, "instructions", "AGENTS.md", "mapped", "обновлена полная копия инструкций", targetDisplay)
      } else {
        addItem(items, "instructions", "AGENTS.md", "unchanged", undefined, targetDisplay)
      }
      nextState.instructions = {
        file: target,
        fullCopy: true,
        hash: hashText(content),
        blocks: {},
      }
      return
    }
  }

  const removeNames =
    previous !== undefined && !previous.fullCopy
      ? Object.keys(previous.blocks).filter((name) => !blocks.some((block) => block.name === name))
      : []
  const parsed = parseInstructionBlocks(current ?? "")
  if (parsed.errors.length > 0) {
    addItem(items, "instructions", "AGENTS.md", "conflict", `маркеры повреждены: ${parsed.errors[0]}`, targetDisplay)
    return
  }
  const editedBlocks =
    previous === undefined
      ? []
      : Object.entries(previous.blocks).filter(([name, hash]) => {
          const body = parsed.blocks.get(name)
          return body !== undefined && hashText(body) !== hash
        })
  const rendered = renderInstructionBlocks(current ?? "", blocks, removeNames)
  if (!rendered.changed) {
    addItem(items, "instructions", "AGENTS.md", "unchanged", undefined, targetDisplay)
  } else {
    actions.push({ kind: "write", target, content: rendered.text })
    addItem(
      items,
      "instructions",
      "AGENTS.md",
      editedBlocks.length > 0 ? "approximate" : "mapped",
      editedBlocks.length > 0
        ? `managed-блоки правились вне harness и перезаписаны: ${editedBlocks.map(([name]) => name).join(", ")}`
        : undefined,
      targetDisplay,
    )
  }
  if (instruction.sourceText !== undefined && instruction.sourceFile !== target) {
    addItem(
      items,
      "instructions",
      "OpenCode",
      "approximate",
      "перенесены только managed-блоки; текст инструкций OpenCode вне маркеров не копировался",
    )
  }
  if (Buffer.byteLength(rendered.text, "utf8") > 32 * 1024) {
    addItem(
      items,
      "instructions",
      "AGENTS.md",
      "approximate",
      "инструкции больше 32 KiB: Codex обрежет их без увеличения project_doc_max_bytes",
    )
  }
  nextState.instructions = {
    file: target,
    fullCopy: false,
    hash: hashText(rendered.text),
    blocks: blockHashes(blocks),
  }
}

/* ---------- mcp ---------- */

async function planMcp(
  scope: Scope,
  desired: CodexDesired,
  paths: ReturnType<typeof codexPaths>,
  state: CodexState,
  nextState: CodexState,
  items: CodexItem[],
  actions: CodexAction[],
  options: { force: boolean },
  environment: CodexEnvironment,
  errors: string[],
): Promise<void> {
  const configText = (await readText(paths.configFile)) ?? ""
  let doc
  try {
    doc = parseTomlText(configText, paths.configFile)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    addItem(items, "mcp", "config.toml", "skipped", "TOML не парсится — MCP не переносились")
    return
  }

  const wanted = new Set(Object.keys(desired.mcp))
  const remove: string[] = []
  const append: Record<string, Record<string, unknown>> = {}

  for (const [name, server] of Object.entries(desired.mcp)) {
    const mapped = mapMcpServer(name, server)
    if (mapped.value === undefined) {
      addItem(items, "mcp", name, "skipped", mapped.message ?? "не удалось смаппить MCP")
      continue
    }
    const exists = hasMcpServer(doc, name)
    const previous = state.mcp.servers[name]
    const current = mcpServerValue(doc, name)
    const currentHash = exists ? hashValue(current) : undefined
    let action: "create" | "update" | "unchanged" | "conflict" = "create"
    if (exists) {
      if (previous === undefined) action = "conflict"
      else if (currentHash !== previous) action = "conflict"
      else if (deepEqual(current, mapped.value)) action = "unchanged"
      else action = "update"
    }
    if (action === "conflict" && !options.force) {
      addItem(
        items,
        "mcp",
        name,
        "conflict",
        previous === undefined
          ? "MCP уже есть в Codex и не принадлежит harness"
          : "MCP изменён вне harness — нужен --force",
        displayCodexPath(scope, paths.configFile, environment),
      )
      continue
    }
    if (action === "conflict") {
      addItem(items, "mcp", name, "forced", "чужой/изменённый MCP перезаписан по --force")
      action = "update"
    } else {
      const origin = desired.mcpOrigins[name] ?? "manifest"
      statusForWrite(
        items,
        "mcp",
        name,
        origin,
        mapped.status === "approximate",
        mapped.message,
        action,
      )
    }
    if (action === "update") {
      remove.push(name)
      append[name] = mapped.value
    } else if (action === "create") {
      append[name] = mapped.value
    }
    nextState.mcp.servers[name] = hashValue(mapped.value)
  }

  for (const name of Object.keys(state.mcp.servers)) {
    if (wanted.has(name)) continue
    if (!hasMcpServer(doc, name)) {
      delete nextState.mcp.servers[name]
      continue
    }
    const current = mcpServerValue(doc, name)
    if (hashValue(current) !== state.mcp.servers[name] && !options.force) {
      addItem(items, "mcp", name, "conflict", "MCP изменён вне harness — удаление требует --force")
      continue
    }
    remove.push(name)
    addItem(items, "mcp", name, options.force ? "forced" : "mapped", "удалён из Codex: нет в OpenCode-манифесте")
    delete nextState.mcp.servers[name]
  }

  if (remove.length > 0 || Object.keys(append).length > 0) {
    let nextText: string
    try {
      nextText = applyMcpChanges(doc, { remove, append }, paths.configFile)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(maskText(message))
      addItem(items, "mcp", "config.toml", "skipped", "TOML не удалось отредактировать безопасно")
      return
    }
    if (nextText !== configText) {
      actions.push({ kind: "write", target: paths.configFile, content: nextText })
    }
  }
  if (Object.keys(nextState.mcp.servers).length > 0 || (await pathExists(paths.configFile))) {
    nextState.mcp.file = paths.configFile
  }
}

/* ---------- execute ---------- */

async function executeAction(action: CodexAction): Promise<ExecutedAction> {
  if (action.kind === "write") {
    await writeTextAtomic(action.target, action.content)
    return { written: action.target }
  }
  if (action.kind === "remove") {
    await fs.rm(action.target, { recursive: true, force: true })
    return { removed: action.target }
  }
  await fs.mkdir(path.dirname(action.target), { recursive: true })
  if (action.mode === "vendor") {
    await copyDir(action.sourceDir, action.target)
    return { written: action.target, actualSkillMode: "vendor" }
  }
  try {
    await fs.rm(action.target, { recursive: true, force: true })
    await createReferenceLink(action.sourceDir, action.target)
    return { written: action.target, actualSkillMode: "reference" }
  } catch {
    /* Codex следует symlink; если ссылка недоступна — безопасный vendor-fallback */
    await copyDir(action.sourceDir, action.target)
    return { written: action.target, actualSkillMode: "vendor" }
  }
}

export async function exportCodex(scope: Scope, options: CodexExportOptions = {}): Promise<CodexExportResult> {
  const environment = options.environment ?? {}
  const paths = codexPaths(scope, environment)
  const items: CodexItem[] = []
  const actions: CodexAction[] = []
  const errors: string[] = []
  const loaded = await loadCodexState(scope, paths.stateFile, paths.codexHome)
  if (loaded.warning !== undefined) errors.push(loaded.warning)
  const state = loaded.state
  const nextState: CodexState = {
    ...state,
    skills: { ...state.skills },
    agents: { ...state.agents },
    mcp: { file: state.mcp.file, servers: { ...state.mcp.servers } },
    ...(state.instructions === undefined
      ? {}
      : { instructions: { ...state.instructions, blocks: { ...state.instructions.blocks } } }),
  }

  const inventory = await inventoryCodex(scope, paths, {
    ...(options.manifestOnly === true ? { manifestOnly: true } : {}),
  })
  items.push(...inventory.desired.items)
  for (const key of inventory.desired.configKeys) {
    addItem(items, "config", key, "skipped", configMessage(key))
  }
  if (scope.kind === "project" && Object.keys(inventory.desired.mcp).length > 0) {
    const trusted = await isProjectTrusted(scope, paths)
    if (!trusted) {
      addItem(
        items,
        "mcp",
        "project-trust",
        "approximate",
        "Codex загрузит project .codex/config.toml только для trusted-проекта; подтверди trust в Codex",
        ".codex/config.toml",
      )
    }
  }

  await planSkills(scope, inventory.desired, paths, state, nextState, items, actions, {
    force: options.force === true,
  }, environment)
  await planAgents(inventory.desired, paths, state, nextState, items, actions, {
    force: options.force === true,
  })
  await planInstructions(
    scope,
    inventory.desired,
    state,
    nextState,
    items,
    actions,
    { force: options.force === true },
    environment,
  )
  await planMcp(
    scope,
    inventory.desired,
    paths,
    state,
    nextState,
    items,
    actions,
    { force: options.force === true },
    environment,
    errors,
  )

  const result: CodexExportResult = {
    scope: scope.kind,
    codexHome: displayHomePath(paths.codexHome, environment),
    dryRun: options.dryRun === true,
    items,
    written: [],
    removed: [],
    errors,
  }
  /* State тоже ownership: даже без изменений артефактов он должен фиксировать
     инструкции/MCP, иначе последующее удаление из манифеста не сработает. */
  const stateComparable = (value: CodexState): string =>
    stableStringify({ ...value, exportedAt: "" })
  const stateChanged = stateComparable(nextState) !== stateComparable(state)
  if (options.dryRun === true || (actions.length === 0 && !stateChanged) || errors.length > 0) {
    return result
  }

  const touched = [
    ...actions.map((action) => action.target),
    paths.stateFile,
  ]
  const backup = await createCodexBackup(scope, paths.backupsDir, touched)
  if (backup !== undefined) result.backupDir = displayCodexPath(scope, backup, environment)

  for (const action of actions) {
    try {
      const executed = await executeAction(action)
      if (executed.written !== undefined) result.written.push(displayCodexPath(scope, executed.written, environment))
      if (executed.removed !== undefined) result.removed.push(displayCodexPath(scope, executed.removed, environment))
      if (action.kind === "skill" && executed.actualSkillMode !== undefined && executed.actualSkillMode !== action.mode) {
        const entry = nextState.skills[action.name]
        if (entry !== undefined) entry.mode = executed.actualSkillMode
        addItem(
          items,
          "skills",
          action.name,
          "approximate",
          "reference-ссылка недоступна — скилл скопирован (vendor)",
        )
      }
    } catch (error) {
      errors.push(
        `не удалось применить ${displayCodexPath(scope, action.target, environment)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return result
    }
  }

  nextState.exportedAt = new Date().toISOString()
  try {
    await writeCodexState(paths.stateFile, nextState)
  } catch (error) {
    errors.push(`не удалось записать state Codex: ${error instanceof Error ? error.message : String(error)}`)
  }
  return result
}

