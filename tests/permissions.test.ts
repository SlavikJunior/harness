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
import { lintPermissions, wildcardMatch } from "../src/verify/permissions.js"
import { runDoctor } from "../src/verify/doctor.js"
import type { CatalogIndex } from "../src/catalog/types.js"

/**
 * Permissions V2: массив правил 1:1 с конфигом, порядок значим,
 * ownership только по state, линты на ослабление .env и тотальный deny.
 */

const EMPTY_CATALOG: CatalogIndex = { sources: {}, skills: [] }

const RULES = `version: 1
permissions:
  - action: shell
    resource: "*"
    effect: ask
  - action: shell
    resource: "git status *"
    effect: allow
`

async function setup(manifestText: string, configText?: string) {
  const project = await tempDir("harness-perm-")
  await writeFixture(project, "harness.yaml", manifestText)
  if (configText !== undefined) {
    await writeFixture(project, ".opencode/opencode.jsonc", configText)
  }
  const manifest = validateManifestText(manifestText)
  const desired = buildDesiredState(project, manifest, EMPTY_CATALOG)
  return { project, manifest, desired, state: emptyState() }
}

async function readConfig(project: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(path.join(project, ".opencode", "opencode.jsonc"), "utf8")
  return JSON.parse(text) as Record<string, unknown>
}

async function withIsolatedXdg<T>(run: () => Promise<T>): Promise<T> {
  const configHome = await tempDir("harness-cfg-")
  const dataHome = await tempDir("harness-data-")
  await writeFixture(configHome, "harness/sources.yaml", "sources: {}\n")
  const restore = isolateXdg(configHome, dataHome)
  try {
    return await run()
  } finally {
    restore()
  }
}

describe("схема permissions", () => {
  it("принимает правила V2 как есть", async () => {
    const { desired } = await setup(RULES)
    expect(desired.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status *", effect: "allow" },
    ])
  })

  it("отклоняет неверный effect, пустой resource, пробел в action и лишние поля", async () => {
    const invalid = [
      "version: 1\npermissions:\n  - action: shell\n    resource: \"*\"\n    effect: block\n",
      "version: 1\npermissions:\n  - action: shell\n    resource: \"\"\n    effect: allow\n",
      "version: 1\npermissions:\n  - action: \"git status\"\n    resource: \"*\"\n    effect: allow\n",
      "version: 1\npermissions:\n  - action: shell\n    resource: \"*\"\n    effect: allow\n    note: лишнее\n",
    ]
    for (const manifest of invalid) {
      await expect(setup(manifest)).rejects.toBeInstanceOf(ManifestValidationError)
    }
  })
})

describe("plan/apply permissions", () => {
  it("создаёт массив, идемпотентен и пишет hash в state", async () => {
    const { project, desired, state } = await setup(RULES)
    const plan = await computePlan(project, desired, state)
    expect(plan.items.find((item) => item.target === "permissions")?.action).toBe("create")
    expect(plan.items.find((item) => item.target === "permissions")?.detail).toBe("2 правила")

    await applyDesired(project, desired, plan, state)
    expect((await readConfig(project)).permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status *", effect: "allow" },
    ])

    const nextState = await loadState(project)
    expect(typeof nextState.permissions?.sha).toBe("string")

    const plan2 = await computePlan(project, desired, nextState)
    expect(plan2.items.filter((item) => item.target === "permissions" && item.action !== "unchanged")).toHaveLength(0)
  })

  it("обновляет количество правил", async () => {
    const { project, desired, state } = await setup(RULES)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const extended = validateManifestText(
      `${RULES}  - action: shell\n    resource: "git push *"\n    effect: deny\n`,
    )
    const desired2 = buildDesiredState(project, extended, EMPTY_CATALOG)
    const state2 = await loadState(project)
    const plan = await computePlan(project, desired2, state2)
    const item = plan.items.find((entry) => entry.target === "permissions")
    expect(item?.action).toBe("update")
    expect(item?.detail).toBe("правил 2 → 3")

    await applyDesired(project, desired2, plan, state2)
    expect(((await readConfig(project)).permissions as unknown[]).length).toBe(3)
  })

  it("видит перестановку правил как update (порядок значим)", async () => {
    const { project, desired, state } = await setup(RULES)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const swapped = validateManifestText(`version: 1
permissions:
  - action: shell
    resource: "git status *"
    effect: allow
  - action: shell
    resource: "*"
    effect: ask
`)
    const desired2 = buildDesiredState(project, swapped, EMPTY_CATALOG)
    const plan = await computePlan(project, desired2, await loadState(project))
    const item = plan.items.find((entry) => entry.target === "permissions")
    expect(item?.action).toBe("update")
    expect(item?.detail).toBe("порядок правил изменён")

    await applyDesired(project, desired2, plan, await loadState(project))
    const rules = (await readConfig(project)).permissions as { resource: string }[]
    expect(rules[0]?.resource).toBe("git status *")
  })

  it("видит drift при ручной правке и перезаписывает правила", async () => {
    const { project, desired, state } = await setup(RULES)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const file = path.join(project, ".opencode", "opencode.jsonc")
    const config = await readConfig(project)
    config.permissions = [{ action: "shell", resource: "*", effect: "allow" }]
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8")

    const driftState = await loadState(project)
    const plan = await computePlan(project, desired, driftState)
    expect(plan.drift.some((entry) => entry.startsWith("permissions:"))).toBe(true)
    const item = plan.items.find((entry) => entry.target === "permissions")
    expect(item?.action).toBe("update")
    expect(item?.warn).toContain("вне harness")

    await applyDesired(project, desired, plan, driftState)
    expect(((await readConfig(project)).permissions as { effect: string }[])[0]?.effect).toBe("ask")
  })

  it("удаляет правила, если секция убрана из манифеста", async () => {
    const { project, desired, state } = await setup(RULES)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const manifest2 = validateManifestText("version: 1\n")
    const desired2 = buildDesiredState(project, manifest2, EMPTY_CATALOG)
    const state2 = await loadState(project)
    const plan = await computePlan(project, desired2, state2)
    expect(plan.items.find((item) => item.target === "permissions")?.action).toBe("remove")

    await applyDesired(project, desired2, plan, state2)
    expect((await readConfig(project)).permissions).toBeUndefined()
    expect((await loadState(project)).permissions).toBeUndefined()
  })

  it("не трогает чужие правила без записи в state", async () => {
    const foreign = JSON.stringify({ $schema: "https://opencode.ai/config.json", permissions: [{ action: "shell", resource: "*", effect: "ask" }] }, null, 2)
    const { project, desired, state } = await setup("version: 1\n", `${foreign}\n`)

    const plan = await computePlan(project, desired, state)
    expect(plan.items.some((item) => item.target === "permissions")).toBe(false)

    await applyDesired(project, desired, plan, state)
    expect((await readConfig(project)).permissions).toEqual([{ action: "shell", resource: "*", effect: "ask" }])
  })
})

describe("линты permissions", () => {
  it("wildcardMatch учитывает V2-семантику (включая ' *' без аргументов)", () => {
    expect(wildcardMatch("*", "config/.env")).toBe(true)
    expect(wildcardMatch("git status *", "git status")).toBe(true)
    expect(wildcardMatch("git status *", "git status --short")).toBe(true)
    expect(wildcardMatch("*.env", "config/.env.local")).toBe(false)
    expect(wildcardMatch("*.env.example", ".env")).toBe(false)
    expect(wildcardMatch("file?.txt", "file1.txt")).toBe(true)
  })

  it("предупреждает об ослаблении .env и тотальном deny", () => {
    expect(lintPermissions([{ action: "read", resource: "*", effect: "allow" }])).toHaveLength(1)
    expect(lintPermissions([{ action: "read", resource: "*.env", effect: "allow" }])).toHaveLength(1)
    expect(lintPermissions([{ action: "read", resource: "*.env", effect: "ask" }])).toHaveLength(0)
    expect(lintPermissions([{ action: "read", resource: "*.env.example", effect: "allow" }])).toHaveLength(0)
    expect(lintPermissions([{ action: "edit", resource: "*", effect: "allow" }])).toHaveLength(0)
    expect(lintPermissions([{ action: "*", resource: "*", effect: "deny" }])).toHaveLength(1)
  })

  it("doctor ловит некорректную форму в конфиге и линтует манифест", async () => {
    await withIsolatedXdg(async () => {
      const project = await tempDir("harness-perm-doctor-")
      await writeFixture(
        project,
        "harness.yaml",
        'version: 1\npermissions:\n  - action: read\n    resource: "*"\n    effect: allow\n',
      )
      await writeFixture(project, ".opencode/opencode.jsonc", '{ "permissions": "allow" }\n')

      const checks = await runDoctor(project)
      expect(checks.some((check) => check.level === "error" && check.message.includes("permissions"))).toBe(true)
      expect(checks.some((check) => check.level === "warn" && check.message.includes(".env"))).toBe(true)
    })
  })
})
