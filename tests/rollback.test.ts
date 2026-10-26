import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildCatalog } from "../src/catalog/index.js"
import { buildDesiredState } from "../src/apply/desired.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { loadState } from "../src/apply/state.js"
import { listBackups, restoreBackup } from "../src/apply/backup.js"
import { validateManifestText } from "../src/manifest/load.js"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"

/**
 * Снапшоты и `apply --undo`: восстановление конфига, скиллов, агентов,
 * блоков инструкций и state; стек undo и dry-run.
 */

const MANIFEST_V1 = `version: 1
skills:
  - source: rollback-local
    name: demo
mcp:
  tester:
    type: local
    command: [echo, v1]
agents:
  reviewer:
    description: Ревью
    body: |
      Версия 1.
instructions:
  blocks:
    build: |
      Сборка: \`echo v1\`.
config:
  model: test/v1
`

const MANIFEST_V2 = `version: 1
skills:
  - source: rollback-local
    name: demo
mcp:
  tester:
    type: local
    command: [echo, v2]
agents:
  reviewer:
    description: Ревью
    body: |
      Версия 2.
instructions:
  blocks:
    build: |
      Сборка: \`echo v2\`.
config:
  model: test/v2
`

async function setup(): Promise<{ project: string; sourceDir: string }> {
  const configHome = await tempDir("harness-rb-cfg-")
  const dataHome = await tempDir("harness-rb-data-")
  isolateXdg(configHome, dataHome)

  const sourceDir = await tempDir("harness-rb-src-")
  await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: v1\n---\nv1\n")
  await writeFixture(
    configHome,
    "harness/sources.yaml",
    `sources:\n  rollback-local:\n    type: local\n    path: ${sourceDir}\n`,
  )
  const project = await tempDir("harness-rb-proj-")
  await writeFixture(project, "harness.yaml", MANIFEST_V1)
  return { project, sourceDir }
}

async function context(project: string, manifestText: string) {
  const manifest = validateManifestText(manifestText)
  const catalog = await buildCatalog({ sourceFilter: ["rollback-local"] })
  const desired = buildDesiredState(project, manifest, catalog)
  const state = await loadState(project)
  const plan = await computePlan(project, desired, state)
  return { manifest, desired, state, plan }
}

async function apply(project: string, manifestText: string) {
  const ctx = await context(project, manifestText)
  return applyDesired(project, ctx.desired, ctx.plan, ctx.state)
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

describe("apply --undo", () => {
  it("откат первого apply удаляет созданные артефакты и state", async () => {
    const { project } = await setup()
    const outcome = await apply(project, MANIFEST_V1)
    expect(outcome.backupDir).toBeDefined()

    const restored = await restoreBackup(project)
    expect(restored.restored).toBe(0)
    expect(restored.removed).toBeGreaterThan(0)

    expect(await exists(path.join(project, ".opencode/opencode.jsonc"))).toBe(false)
    expect(await exists(path.join(project, ".opencode/skills/demo"))).toBe(false)
    expect(await exists(path.join(project, ".opencode/agents/reviewer.md"))).toBe(false)
    expect(await exists(path.join(project, ".harness/state.json"))).toBe(false)
    expect((await loadState(project)).appliedAt).toBe("")
  })

  it("восстанавливает предыдущую версию конфига, mcp, скилла, агента и инструкций", async () => {
    const { project, sourceDir } = await setup()
    await apply(project, MANIFEST_V1)

    /* Версия 2: источник скилла и манифест */
    await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: v2\n---\nv2\n")
    await apply(project, MANIFEST_V2)

    const configV2 = await readJson(path.join(project, ".opencode/opencode.jsonc"))
    expect(configV2.model).toBe("test/v2")

    const restored = await restoreBackup(project)
    expect(restored.dryRun).toBe(false)
    expect(restored.restored).toBeGreaterThan(0)

    const config = await readJson(path.join(project, ".opencode/opencode.jsonc"))
    expect(config.model).toBe("test/v1")
    expect(JSON.stringify(config.mcp)).toContain("v1")

    const skill = await fs.readFile(path.join(project, ".opencode/skills/demo/SKILL.md"), "utf8")
    expect(skill).toContain("v1")

    const agent = await fs.readFile(path.join(project, ".opencode/agents/reviewer.md"), "utf8")
    expect(agent).toContain("Версия 1")

    const agentsMd = await fs.readFile(path.join(project, "AGENTS.md"), "utf8")
    expect(agentsMd).toContain("echo v1")
    expect(agentsMd).not.toContain("echo v2")

    /* Источник тоже вернулся к v1 — план против манифеста v1 пуст */
    await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: v1\n---\nv1\n")
    const check = await context(project, MANIFEST_V1)
    expect(check.plan.items.filter((item) => item.action !== "unchanged")).toHaveLength(0)
    expect(check.plan.drift).toHaveLength(0)
  })

  it("dry-run не меняет файлы и не расходует снапшот", async () => {
    const { project } = await setup()
    await apply(project, MANIFEST_V1)
    const before = await fs.readFile(path.join(project, ".opencode/opencode.jsonc"), "utf8")
    const count = (await listBackups(project)).length

    const restored = await restoreBackup(project, { dryRun: true })
    expect(restored.dryRun).toBe(true)
    expect(restored.actions.length).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(project, ".opencode/opencode.jsonc"), "utf8")).toBe(before)
    expect((await listBackups(project)).length).toBe(count)
  })

  it("без снапшотов — понятная ошибка", async () => {
    const { project } = await setup()
    await expect(restoreBackup(project)).rejects.toThrow(/Нет снапшотов/)
  })

  it("стек undo: повторный откат возвращает ещё более раннее состояние", async () => {
    const { project } = await setup()
    await apply(project, MANIFEST_V1)
    await apply(project, MANIFEST_V2)
    expect((await listBackups(project)).length).toBe(2)

    await restoreBackup(project)
    expect((await listBackups(project)).length).toBe(1)
    await restoreBackup(project)
    expect((await listBackups(project)).length).toBe(0)
    expect(await exists(path.join(project, ".opencode/opencode.jsonc"))).toBe(false)
  })

  it("хранит не больше пяти снапшотов", async () => {
    const { project } = await setup()
    for (let index = 0; index < 7; index++) {
      await apply(project, MANIFEST_V1.replace("test/v1", `test/v${index}`))
    }
    expect((await listBackups(project)).length).toBe(5)
  })
})
