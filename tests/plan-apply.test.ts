import { promises as fs } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildCatalog } from "../src/catalog/index.js"
import { buildDesiredState } from "../src/apply/desired.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { emptyState, loadState } from "../src/apply/state.js"
import { validateManifestText } from "../src/manifest/load.js"
import { validateJsoncText } from "../src/apply/config.js"
import { sameLinkTarget } from "../src/apply/link.js"
import { MANAGED_CONFIG_FILE } from "../src/manifest/file.js"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"

/**
 * E2E: план/apply на временном проекте с local-источником (без сети).
 * Проверяются: создание vendor/reference скиллов, MCP, passthrough-конфиг,
 * идемпотентность повторного плана, drift и удаление по манифесту.
 */

let cleanup: (() => void) | undefined

beforeEach(() => {
  /* isolateXdg вызывается в каждом тесте — здесь ничего */
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

async function setupProject(): Promise<{ project: string; sourceDir: string }> {
  const configHome = await tempDir("harness-cfg-")
  const dataHome = await tempDir("harness-data-")
  const restore = isolateXdg(configHome, dataHome)
  cleanup = restore

  /* local-источник с двумя скиллами */
  const sourceDir = await tempDir("harness-src-")
  await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: Demo skill\n---\nDemo\n")
  await writeFixture(sourceDir, "demo/extra.txt", "payload\n")
  await writeFixture(sourceDir, "demo2/SKILL.md", "---\nname: demo2\ndescription: Second\n---\n")

  await writeFixture(
    configHome,
    "harness/sources.yaml",
    `sources:\n  test-local:\n    type: local\n    path: ${sourceDir}\n`,
  )

  const project = await tempDir("harness-proj-")
  await writeFixture(
    project,
    "harness.yaml",
    `version: 1
skills:
  - source: test-local
    name: demo
  - source: test-local
    name: demo2
    mode: reference
mcp:
  tester:
    type: local
    command: [echo, hi]
config:
  model: test/model
`,
  )
  return { project, sourceDir }
}

describe("plan/apply e2e", () => {
  it("полный цикл: план → apply → идемпотентный план", async () => {
    const { project, sourceDir } = await setupProject()
    const manifest = validateManifestText(await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    const catalog = await buildCatalog({ sourceFilter: ["test-local"] })
    expect(catalog.skills.map((skill) => skill.name).toSorted()).toEqual(["demo", "demo2"])

    const desired = buildDesiredState(project, manifest, catalog)
    expect(desired.skills).toHaveLength(2)

    /* Первый план: всё создать */
    const plan1 = await computePlan(project, desired, emptyState())
    const creates = plan1.items.filter((item) => item.action === "create").map((item) => item.target)
    expect(creates).toContain("skill:demo")
    expect(creates).toContain("skill:demo2")
    expect(creates).toContain("mcp:tester")
    expect(creates).toContain("config:model")
    expect(plan1.blocked).toBeUndefined()

    /* Apply */
    const outcome = await applyDesired(project, desired, plan1, emptyState())
    expect(outcome.dryRun).toBe(false)
    expect(outcome.applied).toHaveLength(creates.length)

    /* Артефакты */
    const vendored = await fs.readFile(path.join(project, ".opencode", "skills", "demo", "SKILL.md"), "utf8")
    expect(vendored).toContain("Demo skill")
    const linkStat = await fs.lstat(path.join(project, ".opencode", "skills", "demo2"))
    expect(linkStat.isSymbolicLink()).toBe(true)
    const linkTarget = await fs.readlink(path.join(project, ".opencode", "skills", "demo2"))
    expect(sameLinkTarget(linkTarget, path.join(project, ".opencode", "skills", "demo2"), path.join(sourceDir, "demo2"))).toBe(true)

    /* Конфиг */
    const configText = await fs.readFile(MANAGED_CONFIG_FILE(project), "utf8")
    expect(validateJsoncText(configText)).toBeUndefined()
    expect(configText).toContain("test/model")
    expect(configText).toContain("tester")

    /* State и gitignore */
    const state = await loadState(project)
    expect(state.appliedAt).not.toBe("")
    expect(state.skills.demo?.mode).toBe("vendor")
    expect(state.skills.demo2?.mode).toBe("reference")
    const gitignore = await fs.readFile(path.join(project, ".gitignore"), "utf8")
    expect(gitignore).toContain(".harness/")

    /* Повторный план: без изменений */
    const plan2 = await computePlan(project, desired, state)
    expect(plan2.items.filter((item) => item.action !== "unchanged")).toHaveLength(0)
    expect(plan2.drift).toHaveLength(0)
  })

  it("dry-run ничего не пишет", async () => {
    const { project } = await setupProject()
    const manifest = validateManifestText(await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    const catalog = await buildCatalog({ sourceFilter: ["test-local"] })
    const desired = buildDesiredState(project, manifest, catalog)
    const plan = await computePlan(project, desired, emptyState())

    const outcome = await applyDesired(project, desired, plan, emptyState(), { dryRun: true })
    expect(outcome.dryRun).toBe(true)
    await expect(fs.access(path.join(project, ".opencode"))).rejects.toThrow()
  })

  it("обнаруживает drift и правку манифеста → удаление", async () => {
    const { project } = await setupProject()
    const manifest = validateManifestText(await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    const catalog = await buildCatalog({ sourceFilter: ["test-local"] })
    const desired = buildDesiredState(project, manifest, catalog)
    const initialState = emptyState()
    await applyDesired(project, desired, await computePlan(project, desired, initialState), initialState)

    /* Ручная правка управляемого конфига → drift */
    const managedFile = MANAGED_CONFIG_FILE(project)
    const edited = (await fs.readFile(managedFile, "utf8")).replace("test/model", "user/overridden")
    await fs.writeFile(managedFile, edited, "utf8")

    const state = await loadState(project)
    const driftPlan = await computePlan(project, desired, state)
    expect(driftPlan.drift.some((entry) => entry.includes("config:model"))).toBe(true)

    /* Повторный apply конвергентен: возвращает значение манифеста */
    await applyDesired(project, desired, driftPlan, state)
    expect(await fs.readFile(managedFile, "utf8")).toContain("test/model")

    /* Скилл удалён из манифеста → remove по плану и на диске */
    await fs.writeFile(
      path.join(project, "harness.yaml"),
      "version: 1\nskills:\n  - source: test-local\n    name: demo\nmcp:\n  tester:\n    type: local\n    command: [echo, hi]\nconfig:\n  model: test/model\n",
      "utf8",
    )
    const manifest2 = validateManifestText(await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    const desired2 = buildDesiredState(project, manifest2, await buildCatalog({ sourceFilter: ["test-local"] }))
    const state2 = await loadState(project)
    const removePlan = await computePlan(project, desired2, state2)
    const removals = removePlan.items.filter((item) => item.action === "remove").map((item) => item.target)
    expect(removals).toContain("skill:demo2")

    await applyDesired(project, desired2, removePlan, state2)
    await expect(fs.lstat(path.join(project, ".opencode", "skills", "demo2"))).rejects.toThrow()
    expect(await fs.lstat(path.join(project, ".opencode", "skills", "demo"))).toBeTruthy()
  })

  it("план не печатает плейнтекст-секреты (маскировка)", async () => {
    const { project } = await setupProject()
    const configSecret = "sk-proj-AbCdEfGhIjKlMnOp1234"
    const commandSecret = `ghp_${"a".repeat(36)}`
    await fs.writeFile(
      path.join(project, "harness.yaml"),
      `version: 1
mcp:
  leak:
    type: local
    command: [srv, --token, ${commandSecret}]
  remote:
    type: remote
    url: "https://user:pa55w0rd@db.example.com/mcp"
config:
  apiKey: ${configSecret}
`,
      "utf8",
    )
    const manifest = validateManifestText(await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    const desired = buildDesiredState(project, manifest, await buildCatalog({ sourceFilter: ["test-local"] }))
    const plan = await computePlan(project, desired, emptyState())
    const serialized = JSON.stringify(plan.items)
    expect(serialized).not.toContain(configSecret)
    expect(serialized).not.toContain(commandSecret)
    expect(serialized).not.toContain("pa55w0rd")
    expect(serialized).toContain("•••")
  })

  it("конфликт passthrough с прямым конфигом пользователя виден в плане", async () => {
    const { project } = await setupProject()
    await writeFixture(project, "opencode.json", '{ "model": "user/model" }\n')
    const manifest = validateManifestText(await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    const desired = buildDesiredState(project, manifest, await buildCatalog({ sourceFilter: ["test-local"] }))
    const plan = await computePlan(project, desired, emptyState())
    expect(plan.conflicts.some((entry) => entry.includes("config:model") && entry.includes("opencode.json"))).toBe(true)
  })
})
