import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"
import { validateManifestText } from "../src/manifest/load.js"
import { buildDesiredState } from "../src/apply/desired.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { emptyState, loadState } from "../src/apply/state.js"
import { ManifestValidationError } from "../src/core/errors.js"
import { lintPolicies } from "../src/verify/policies.js"
import { runDoctor } from "../src/verify/doctor.js"
import type { CatalogIndex } from "../src/catalog/types.js"

/**
 * Policies V2: жёсткий deny, ownership по state, порядок значим,
 * allow/ask отклоняются схемой, линты на слишком широкие запреты.
 */

const EMPTY_CATALOG: CatalogIndex = { sources: {}, skills: [] }

const POLICIES = `version: 1
policies:
  - action: shell
    resource: "sudo *"
    effect: deny
  - action: webfetch
    resource: "*"
    effect: deny
`

async function setup(manifestText: string, configText?: string) {
  const project = await tempDir("harness-policies-")
  await writeFixture(project, "harness.yaml", manifestText)
  if (configText !== undefined) await writeFixture(project, ".opencode/opencode.jsonc", configText)
  const manifest = validateManifestText(manifestText)
  const desired = buildDesiredState(project, manifest, EMPTY_CATALOG)
  return { project, desired, state: emptyState() }
}

async function readConfig(project: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(project, ".opencode", "opencode.jsonc"), "utf8"))
}

describe("схема policies", () => {
  it("принимает только deny", async () => {
    const { desired } = await setup(POLICIES)
    expect(desired.policies).toEqual([
      { action: "shell", resource: "sudo *", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
    ])
  })

  it("отклоняет allow/ask, пустой resource и лишние поля", async () => {
    const invalid = [
      'version: 1\npolicies:\n  - action: shell\n    resource: "*"\n    effect: allow\n',
      'version: 1\npolicies:\n  - action: shell\n    resource: "*"\n    effect: ask\n',
      'version: 1\npolicies:\n  - action: shell\n    resource: ""\n    effect: deny\n',
      'version: 1\npolicies:\n  - action: shell\n    resource: "*"\n    effect: deny\n    note: лишнее\n',
    ]
    for (const manifest of invalid) {
      await expect(setup(manifest)).rejects.toBeInstanceOf(ManifestValidationError)
    }
  })
})

describe("plan/apply policies", () => {
  it("создаёт, идемпотентен и пишет hash в state", async () => {
    const { project, desired, state } = await setup(POLICIES)
    const plan = await computePlan(project, desired, state)
    const item = plan.items.find((entry) => entry.target === "policies")
    expect(item?.action).toBe("create")
    expect(item?.detail).toBe("2 правила")

    await applyDesired(project, desired, plan, state)
    expect((await readConfig(project)).policies).toEqual([
      { action: "shell", resource: "sudo *", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
    ])
    const nextState = await loadState(project)
    expect(typeof nextState.policies?.sha).toBe("string")

    const plan2 = await computePlan(project, desired, nextState)
    expect(plan2.items.filter((entry) => entry.target === "policies" && entry.action !== "unchanged")).toHaveLength(0)
  })

  it("видит перестановку и удаляет секцию после apply", async () => {
    const { project, desired, state } = await setup(POLICIES)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const swapped = validateManifestText(`version: 1
policies:
  - action: webfetch
    resource: "*"
    effect: deny
  - action: shell
    resource: "sudo *"
    effect: deny
`)
    const desired2 = buildDesiredState(project, swapped, EMPTY_CATALOG)
    const plan = await computePlan(project, desired2, await loadState(project))
    expect(plan.items.find((entry) => entry.target === "policies")?.detail).toBe("порядок правил изменён")

    await applyDesired(project, desired2, plan, await loadState(project))
    const withoutPolicies = buildDesiredState(project, validateManifestText("version: 1\n"), EMPTY_CATALOG)
    const state2 = await loadState(project)
    const removePlan = await computePlan(project, withoutPolicies, state2)
    expect(removePlan.items.find((entry) => entry.target === "policies")?.action).toBe("remove")
    await applyDesired(project, withoutPolicies, removePlan, state2)
    expect((await readConfig(project)).policies).toBeUndefined()
  })

  it("видит drift и не трогает чужие правила без state", async () => {
    const { project, desired, state } = await setup(POLICIES)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const file = path.join(project, ".opencode", "opencode.jsonc")
    const config = await readConfig(project)
    config.policies = [{ action: "shell", resource: "*", effect: "deny" }]
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8")

    const driftState = await loadState(project)
    const plan = await computePlan(project, desired, driftState)
    expect(plan.drift.some((entry) => entry.startsWith("policies:"))).toBe(true)
    expect(plan.items.find((entry) => entry.target === "policies")?.warn).toContain("вне harness")
    await applyDesired(project, desired, plan, driftState)
    expect(((await readConfig(project)).policies as unknown[]).length).toBe(2)

    const foreign = { $schema: "https://opencode.ai/config.json", policies: [{ action: "shell", resource: "rm *", effect: "deny" }] }
    const fresh = await setup("version: 1\n", `${JSON.stringify(foreign, null, 2)}\n`)
    const foreignPlan = await computePlan(fresh.project, fresh.desired, fresh.state)
    expect(foreignPlan.items.some((entry) => entry.target === "policies")).toBe(false)
    await applyDesired(fresh.project, fresh.desired, foreignPlan, fresh.state)
    expect((await readConfig(fresh.project)).policies).toEqual([{ action: "shell", resource: "rm *", effect: "deny" }])
  })
})

describe("линты policies", () => {
  it("предупреждает о тотальном и read-запрете, но не о точечном", () => {
    expect(lintPolicies([{ action: "*", resource: "*", effect: "deny" }])).toHaveLength(1)
    expect(lintPolicies([{ action: "read", resource: "*", effect: "deny" }])).toHaveLength(1)
    expect(lintPolicies([{ action: "shell", resource: "sudo *", effect: "deny" }])).toHaveLength(0)
  })

  it("doctor ловит неверную форму фактического конфига", async () => {
    const configHome = await tempDir("harness-cfg-")
    const dataHome = await tempDir("harness-data-")
    const restore = isolateXdg(configHome, dataHome)
    try {
      const project = await tempDir("harness-policies-doctor-")
      await writeFixture(
        project,
        "harness.yaml",
        'version: 1\npolicies:\n  - action: "*"\n    resource: "*"\n    effect: deny\n',
      )
      await writeFixture(
        project,
        ".opencode/opencode.jsonc",
        '{ "policies": [{ "action": "shell", "resource": "*", "effect": "allow" }] }\n',
      )
      const checks = await runDoctor(project)
      expect(checks.some((check) => check.level === "error" && check.message.includes("policies"))).toBe(true)
      expect(checks.some((check) => check.level === "warn" && check.message.includes("блокирует все проверки"))).toBe(true)
    } finally {
      restore()
    }
  })
})
