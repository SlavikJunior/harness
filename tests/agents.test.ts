import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { tempDir, writeFixture } from "./helpers.js"
import { validateManifestText } from "../src/manifest/load.js"
import { buildDesiredState } from "../src/apply/desired.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { emptyState, loadState } from "../src/apply/state.js"
import { ManifestValidationError } from "../src/core/errors.js"
import { normalizeAgentContent, renderAgent } from "../src/apply/agents.js"
import { scanManifest } from "../src/secrets/scan.js"
import type { CatalogIndex } from "../src/catalog/types.js"

/**
 * Markdown-агенты: рендер frontmatter, ownership файлов по state,
 * drift, удаление и аудит секретов в body.
 */

const EMPTY_CATALOG: CatalogIndex = { sources: {}, skills: [] }

const AGENTS = `version: 1
agents:
  reviewer:
    description: Ревью изменений
    mode: subagent
    model: anthropic/claude-sonnet-5-5#high
    permissions:
      - action: edit
        resource: "*"
        effect: deny
    body: |
      Проверь изменения и перечисли находки.
  helper:
    description: Простой помощник
`

async function setup(manifestText: string) {
  const project = await tempDir("harness-agents-")
  await writeFixture(project, "harness.yaml", manifestText)
  const manifest = validateManifestText(manifestText)
  const desired = buildDesiredState(project, manifest, EMPTY_CATALOG)
  return { project, manifest, desired, state: emptyState() }
}

function agentPath(project: string, name: string): string {
  return path.join(project, ".opencode", "agents", `${name}.md`)
}

describe("схема агентов", () => {
  it("принимает поддерживаемые поля", async () => {
    const { desired } = await setup(AGENTS)
    expect(desired.agents.map((agent) => agent.name)).toEqual(["helper", "reviewer"])
    expect(desired.agents[1]?.definition.mode).toBe("subagent")
    expect(desired.agents[1]?.file.endsWith(path.join(".opencode", "agents", "reviewer.md"))).toBe(true)
  })

  it("отклоняет неверный mode, лишние поля, слэш в имени и пустого агента", async () => {
    const invalid = [
      "version: 1\nagents:\n  x:\n    mode: worker\n",
      "version: 1\nagents:\n  x:\n    description: ok\n    steps: 8\n",
      "version: 1\nagents:\n  team/reviewer:\n    description: ok\n",
      "version: 1\nagents:\n  x: {}\n",
    ]
    for (const manifest of invalid) {
      await expect(setup(manifest)).rejects.toBeInstanceOf(ManifestValidationError)
    }
  })
})

describe("рендер агента", () => {
  it("фиксирует порядок frontmatter и кладёт body в конец", () => {
    const content = renderAgent({
      description: "Ревью",
      mode: "subagent",
      model: "anthropic/claude-sonnet-5-5#high",
      permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      body: "Проверь изменения.",
    })
    expect(content.startsWith("---\ndescription: Ревью\nmode: subagent\nmodel: ")).toBe(true)
    expect(content).toContain("permissions:\n  - action: edit")
    expect(content).toContain("claude-sonnet-5-5#high")
    expect(content.trimEnd().endsWith("Проверь изменения.")).toBe(true)
    expect(normalizeAgentContent(content)).toBe(content)
  })

  it("нормализует CRLF и не добавляет лишних переводов", () => {
    expect(normalizeAgentContent("---\r\nmode: all\r\n---\r\nbody\r\n\r\n")).toBe("---\nmode: all\n---\nbody\n")
  })
})

describe("plan/apply агентов", () => {
  it("создаёт файлы, идемпотентен и пишет sha в state", async () => {
    const { project, desired, state } = await setup(AGENTS)
    const plan = await computePlan(project, desired, state)
    const creates = plan.items.filter((item) => item.kind === "agent" && item.action === "create")
    expect(creates.map((item) => item.target)).toEqual(["agent:helper", "agent:reviewer"])

    await applyDesired(project, desired, plan, state)
    const content = await fs.readFile(agentPath(project, "reviewer"), "utf8")
    expect(content.startsWith("---\ndescription: Ревью изменений")).toBe(true)
    expect(content).toContain("mode: subagent")
    expect(content.trimEnd().endsWith("Проверь изменения и перечисли находки.")).toBe(true)

    const nextState = await loadState(project)
    expect(typeof nextState.agents.reviewer?.sha).toBe("string")

    const plan2 = await computePlan(project, desired, nextState)
    expect(plan2.items.filter((item) => item.kind === "agent" && item.action !== "unchanged")).toHaveLength(0)
  })

  it("обновляет body и видит ручную правку как drift", async () => {
    const { project, desired, state } = await setup(AGENTS)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const updated = validateManifestText(AGENTS.replace("Проверь изменения и перечисли находки.", "Только ревью."))
    const desired2 = buildDesiredState(project, updated, EMPTY_CATALOG)
    const plan = await computePlan(project, desired2, await loadState(project))
    expect(plan.items.find((item) => item.target === "agent:reviewer")?.action).toBe("update")
    await applyDesired(project, desired2, plan, await loadState(project))
    expect(await fs.readFile(agentPath(project, "reviewer"), "utf8")).toContain("Только ревью.")

    /* Ручная правка управляемого файла → drift и восстановление */
    await fs.appendFile(agentPath(project, "reviewer"), "\nлишнее\n", "utf8")
    const driftState = await loadState(project)
    const driftPlan = await computePlan(project, desired2, driftState)
    expect(driftPlan.drift.some((entry) => entry.startsWith("agent:reviewer"))).toBe(true)
    expect(driftPlan.items.find((item) => item.target === "agent:reviewer")?.warn).toContain("вне harness")
    await applyDesired(project, desired2, driftPlan, driftState)
    expect(await fs.readFile(agentPath(project, "reviewer"), "utf8")).not.toContain("лишнее")
  })

  it("удаляет только записанные файлы и не трогает чужие", async () => {
    const { project, desired, state } = await setup(AGENTS)
    await writeFixture(project, ".opencode/agents/other.md", "---\ndescription: Чужой\n---\n")
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const withoutAgents = buildDesiredState(project, validateManifestText("version: 1\n"), EMPTY_CATALOG)
    const state2 = await loadState(project)
    const removePlan = await computePlan(project, withoutAgents, state2)
    const removals = removePlan.items.filter((item) => item.kind === "agent" && item.action === "remove")
    expect(removals.map((item) => item.target)).toEqual(["agent:helper", "agent:reviewer"])
    await applyDesired(project, withoutAgents, removePlan, state2)

    await expect(fs.access(agentPath(project, "reviewer"))).rejects.toThrow()
    await expect(fs.access(agentPath(project, "helper"))).rejects.toThrow()
    expect(await fs.readFile(agentPath(project, "other"), "utf8")).toContain("Чужой")
    expect((await loadState(project)).agents).toEqual({})
  })

  it("перезаписывает одноимённый файл вне harness с предупреждением", async () => {
    const { project, desired, state } = await setup(AGENTS)
    await writeFixture(project, ".opencode/agents/reviewer.md", "---\ndescription: Старый\n---\nстарое\n")

    const plan = await computePlan(project, desired, state)
    const item = plan.items.find((entry) => entry.target === "agent:reviewer")
    expect(item?.action).toBe("update")
    expect(item?.warn).toContain("вне harness")
    await applyDesired(project, desired, plan, state)
    expect(await fs.readFile(agentPath(project, "reviewer"), "utf8")).toContain("Ревью изменений")
  })
})

describe("секреты в агентах", () => {
  it("сканирует body и не печатает значение", () => {
    const secret = "sk-proj-AbCdEfGhIjKlMnOp1234"
    const manifest = validateManifestText(
      `version: 1\nagents:\n  leak:\n    body: |\n      Используй ключ ${secret} для теста.\n`,
    )
    const findings = scanManifest(manifest)
    expect(findings[0]).toMatchObject({ path: "agents.leak.body", kind: "pattern" })
    expect(JSON.stringify(findings)).not.toContain(secret)
  })
})
