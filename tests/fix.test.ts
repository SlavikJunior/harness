import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildCatalog } from "../src/catalog/index.js"
import { buildDesiredState } from "../src/apply/desired.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { loadState } from "../src/apply/state.js"
import { validateManifestText } from "../src/manifest/load.js"
import { autoFix, unsafeReasons } from "../src/verify/fix.js"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"

/**
 * doctor --fix: автоисправление только безопасного (создать отсутствующее,
 * убрать лишнее). Ручные правки и чужие ключи требуют явного apply.
 */

const MANIFEST = `version: 1
skills:
  - source: fix-local
    name: demo
mcp:
  tester:
    type: local
    command: [echo, hi]
agents:
  reviewer:
    description: Ревью
    body: |
      Проверь изменения.
instructions:
  blocks:
    build: |
      Сборка: \`echo build\`.
config:
  model: test/model
`

async function setup(): Promise<{ project: string; manifestText: string }> {
  const configHome = await tempDir("harness-fix-cfg-")
  const dataHome = await tempDir("harness-fix-data-")
  isolateXdg(configHome, dataHome)

  const sourceDir = await tempDir("harness-fix-src-")
  await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\n---\n")
  await writeFixture(
    configHome,
    "harness/sources.yaml",
    `sources:\n  fix-local:\n    type: local\n    path: ${sourceDir}\n`,
  )
  const project = await tempDir("harness-fix-proj-")
  await writeFixture(project, "harness.yaml", MANIFEST)
  return { project, manifestText: MANIFEST }
}

async function context(project: string, manifestText: string) {
  const manifest = validateManifestText(manifestText)
  const catalog = await buildCatalog({ sourceFilter: ["fix-local"] })
  const desired = buildDesiredState(project, manifest, catalog)
  const state = await loadState(project)
  const plan = await computePlan(project, desired, state)
  return { manifest, desired, state, plan }
}

async function apply(project: string, manifestText: string) {
  const ctx = await context(project, manifestText)
  return applyDesired(project, ctx.desired, ctx.plan, ctx.state)
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

describe("unsafeReasons", () => {
  it("блокирует ручные правки и чужие ключи, разрешает восстановление", async () => {
    const { project, manifestText } = await setup()
    await apply(project, manifestText)

    /* Удалённый агентом файл = create с warn, это безопасно */
    await fs.rm(path.join(project, ".opencode/agents/reviewer.md"))
    const deleted = await context(project, manifestText)
    expect(unsafeReasons(deleted.plan, deleted.state)).toEqual([])

    /* Ручная правка агента = update с warn, небезопасно */
    await apply(project, manifestText)
    await fs.writeFile(path.join(project, ".opencode/agents/reviewer.md"), "---\ndescription: x\n---\nчужое\n", "utf8")
    const edited = await context(project, manifestText)
    expect(unsafeReasons(edited.plan, edited.state).some((reason) => reason.includes("agent:reviewer"))).toBe(true)
  })

  it("ключ конфига, заданный вне harness, — небезопасен", async () => {
    const { project } = await setup()
    await writeFixture(project, ".opencode/opencode.jsonc", '{ "model": "user/model" }\n')
    const ctx = await context(project, MANIFEST)
    expect(unsafeReasons(ctx.plan, ctx.state).some((reason) => reason.includes("config:model"))).toBe(true)
  })
})

describe("autoFix", () => {
  it("восстанавливает удалённые артефакты и остаётся идемпотентным", async () => {
    const { project, manifestText } = await setup()
    await apply(project, manifestText)

    await fs.rm(path.join(project, ".opencode/skills/demo"), { recursive: true, force: true })
    await fs.rm(path.join(project, ".opencode/agents/reviewer.md"))
    const agentsMd = path.join(project, "AGENTS.md")
    const text = await fs.readFile(agentsMd, "utf8")
    await fs.writeFile(agentsMd, text.replace(/<!-- harness:begin:build -->[\s\S]*?<!-- harness:end:build -->\n?/, ""), "utf8")

    const result = await autoFix(project)
    expect(result.skipped).toEqual([])
    expect(result.fixed.map((item) => item.target)).toEqual(
      expect.arrayContaining(["skill:demo", "agent:reviewer", "instructions:build"]),
    )
    expect(await exists(path.join(project, ".opencode/skills/demo/SKILL.md"))).toBe(true)
    expect(await exists(path.join(project, ".opencode/agents/reviewer.md"))).toBe(true)
    expect(await fs.readFile(agentsMd, "utf8")).toContain("echo build")

    const again = await autoFix(project)
    expect(again.fixed).toEqual([])
    expect(again.skipped).toEqual([])
  })

  it("создаёт отсутствующие ключи, не трогая чужие в managed-конфиге", async () => {
    const { project } = await setup()
    await writeFixture(project, ".opencode/opencode.jsonc", '{ "theme": "dark" }\n')

    const result = await autoFix(project)
    expect(result.skipped).toEqual([])
    const config = JSON.parse(await fs.readFile(path.join(project, ".opencode/opencode.jsonc"), "utf8"))
    expect(config.theme).toBe("dark")
    expect(config.model).toBe("test/model")
  })

  it("удаляет то, что убрано из манифеста", async () => {
    const { project, manifestText } = await setup()
    await apply(project, manifestText)
    const short = "version: 1\nconfig:\n  model: test/model\n"
    await fs.writeFile(path.join(project, "harness.yaml"), short, "utf8")

    const result = await autoFix(project)
    expect(result.skipped).toEqual([])
    expect(result.fixed.map((item) => item.target)).toEqual(
      expect.arrayContaining(["skill:demo", "mcp:tester", "agent:reviewer", "instructions:build"]),
    )
    expect(await exists(path.join(project, ".opencode/skills/demo"))).toBe(false)
    expect(await exists(path.join(project, ".opencode/agents/reviewer.md"))).toBe(false)
  })

  it("не перезаписывает ручные правки", async () => {
    const { project, manifestText } = await setup()
    await apply(project, manifestText)
    const agentFile = path.join(project, ".opencode/agents/reviewer.md")
    await fs.writeFile(agentFile, "---\ndescription: моё\n---\nручной текст\n", "utf8")

    const result = await autoFix(project)
    expect(result.fixed).toEqual([])
    expect(result.skipped.some((reason) => reason.includes("agent:reviewer"))).toBe(true)
    expect(await fs.readFile(agentFile, "utf8")).toContain("ручной текст")
  })
})
