import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildCatalog } from "../src/catalog/index.js"
import { buildDesiredState } from "../src/apply/desired.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { emptyState, loadState } from "../src/apply/state.js"
import { validateManifestText } from "../src/manifest/load.js"
import { computeDiff, diffText } from "../src/apply/diff.js"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"

/**
 * Подробный diff: значения конфига/MCP, файлы скиллов, агенты, инструкции.
 * Отдельно проверяется, что секреты в diff замаскированы.
 */

async function setup(): Promise<{ project: string; sourceDir: string }> {
  const configHome = await tempDir("harness-diff-cfg-")
  const dataHome = await tempDir("harness-diff-data-")
  isolateXdg(configHome, dataHome)

  const sourceDir = await tempDir("harness-diff-src-")
  await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: v1\n---\nv1\n")
  await writeFixture(sourceDir, "demo/extra.txt", "one\n")
  await writeFixture(
    configHome,
    "harness/sources.yaml",
    `sources:\n  diff-local:\n    type: local\n    path: ${sourceDir}\n`,
  )

  const project = await tempDir("harness-diff-proj-")
  await writeFixture(
    project,
    "harness.yaml",
    `version: 1
skills:
  - source: diff-local
    name: demo
mcp:
  tester:
    type: local
    command: [echo, v1]
agents:
  reviewer:
    description: Ревью
    body: |
      Первая версия.
instructions:
  blocks:
    build: |
      Сборка: \`echo v1\`.
config:
  model: test/v1
`,
  )
  return { project, sourceDir }
}

async function planFor(project: string, manifestText: string) {
  const manifest = validateManifestText(manifestText)
  const catalog = await buildCatalog({ sourceFilter: ["diff-local"] })
  const desired = buildDesiredState(project, manifest, catalog)
  const state = await loadState(project)
  const plan = await computePlan(project, desired, state)
  return { manifest, desired, state, plan }
}

describe("diffText", () => {
  it("показывает добавленные, удалённые и изменённые строки", () => {
    const result = diffText("a\nb\nc\n", "a\nB\nc\nd\n")
    expect(result.lines).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
      { type: "add", text: "d" },
      { type: "context", text: "" },
    ])
    expect(result.truncated).toBe(false)
  })

  it("undefined с одной стороны — только add/remove", () => {
    expect(diffText(undefined, "x\ny").lines).toEqual([
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ])
    expect(diffText("x\ny", undefined).lines).toEqual([
      { type: "remove", text: "x" },
      { type: "remove", text: "y" },
    ])
  })
})

describe("computeDiff", () => {
  it("после apply изменённый манифест даёт diff по всем категориям", async () => {
    const { project, sourceDir } = await setup()
    const v1 = await planFor(project, await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    await applyDesired(project, v1.desired, v1.plan, v1.state)

    /* Меняем источник skill (vendor) и манифест */
    await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: v2\n---\nv2\n")
    await writeFixture(sourceDir, "demo/extra.txt", "two\n")
    const next = await planFor(
      project,
      `version: 1
skills:
  - source: diff-local
    name: demo
mcp:
  tester:
    type: local
    command: [echo, v2]
agents:
  reviewer:
    description: Ревью
    body: |
      Вторая версия.
instructions:
  blocks:
    build: |
      Сборка: \`echo v2\`.
config:
  model: test/v2
  formatter: true
`,
    )

    const report = await computeDiff(project, next.desired, next.state, next.plan)
    expect(report.blocked).toBeUndefined()
    const targets = report.entries.map((entry) => entry.target)
    expect(targets).toContain("config:model")
    expect(targets).toContain("config:formatter")
    expect(targets).toContain("mcp:tester")
    expect(targets).toContain("agent:reviewer")
    expect(targets).toContain("instructions:build")
    expect(targets).toContain("skill:demo")

    const config = report.entries.find((entry) => entry.target === "config:model")
    expect(config?.lines.some((line) => line.type === "remove" && line.text.includes("test/v1"))).toBe(true)
    expect(config?.lines.some((line) => line.type === "add" && line.text.includes("test/v2"))).toBe(true)

    const skill = report.entries.find((entry) => entry.target === "skill:demo")
    expect(skill?.lines.some((line) => line.type === "change" && line.text === "SKILL.md")).toBe(true)
    expect(skill?.lines.some((line) => line.type === "change" && line.text === "extra.txt")).toBe(true)

    const agent = report.entries.find((entry) => entry.target === "agent:reviewer")
    expect(agent?.lines.some((line) => line.type === "remove" && line.text.includes("Первая версия"))).toBe(true)
    expect(agent?.lines.some((line) => line.type === "add" && line.text.includes("Вторая версия"))).toBe(true)
  })

  it("секреты в diff маскируются", async () => {
    const { project } = await setup()
    const secret = "sk-proj-AbCdEfGhIjKlMnOp1234"
    const next = await planFor(
      project,
      `version: 1
config:
  apiKey: ${secret}
  nested:
    token: ${secret}
`,
    )
    const report = await computeDiff(project, next.desired, next.state, next.plan)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(secret)
    expect(serialized).toContain("•••")
  })

  it("заблокированный план не строит diff", async () => {
    const { project } = await setup()
    await writeFixture(project, ".opencode/opencode.jsonc", "{ broken")
    const next = await planFor(project, await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    const report = await computeDiff(project, next.desired, next.state, next.plan)
    expect(report.entries).toEqual([])
    expect(report.blocked).toContain("JSONC")
  })

  it("удалённый скилл показывает файлы, которые уйдут", async () => {
    const { project } = await setup()
    const v1 = await planFor(project, await fs.readFile(path.join(project, "harness.yaml"), "utf8"))
    await applyDesired(project, v1.desired, v1.plan, v1.state)

    const empty = await planFor(project, "version: 1\n")
    const report = await computeDiff(project, empty.desired, empty.state, empty.plan)
    const skill = report.entries.find((entry) => entry.target === "skill:demo")
    expect(skill?.lines.map((line) => line.text)).toEqual(expect.arrayContaining(["SKILL.md", "extra.txt"]))
    expect(skill?.lines.every((line) => line.type === "remove")).toBe(true)
  })
})
