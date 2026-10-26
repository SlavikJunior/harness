import { promises as fs } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"
import { buildCatalog } from "../src/catalog/index.js"
import { buildDesiredState } from "../src/apply/desired.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { emptyState, loadState } from "../src/apply/state.js"
import { validateManifestText } from "../src/manifest/load.js"
import { runDoctor } from "../src/verify/doctor.js"
import {
  displayPath,
  globalScope,
  projectScope,
  resolveScope,
  scopeFrom,
} from "../src/scope.js"

/**
 * Глобальный скоуп: манифест/state в ~/.config/harness, артефакты —
 * в ~/.config/opencode, проектный каталог не затрагивается.
 */

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

async function isolate(): Promise<{ configHome: string; dataHome: string }> {
  const configHome = await tempDir("harness-cfg-")
  const dataHome = await tempDir("harness-data-")
  cleanup = isolateXdg(configHome, dataHome)
  return { configHome, dataHome }
}

describe("scope", () => {
  it("проектный скоуп — пути внутри проекта", () => {
    const scope = projectScope("/tmp/project")
    expect(scope.kind).toBe("project")
    expect(scope.configFile).toBe(path.join("/tmp/project", ".opencode", "opencode.jsonc"))
    expect(scope.stateFile).toBe(path.join("/tmp/project", ".harness", "state.json"))
    expect(scope.manifestFile).toBe(path.join("/tmp/project", "harness.yaml"))
    expect(scopeFrom("/tmp/project")).toEqual(scope)
    expect(displayPath(scope, scope.configFile)).toBe(path.join(".opencode", "opencode.jsonc"))
  })

  it("глобальный скоуп выбирает существующий конфиг и не подменяет его", async () => {
    const { configHome } = await isolate()
    const globalDir = path.join(configHome, "opencode")

    const empty = await globalScope()
    expect(empty.kind).toBe("global")
    expect(empty.configFile).toBe(path.join(globalDir, "opencode.jsonc"))
    expect(empty.manifestFile).toBe(path.join(configHome, "harness", "harness.yaml"))

    await writeFixture(globalDir, "opencode.json", "{}\n")
    expect((await globalScope()).configFile).toBe(path.join(globalDir, "opencode.json"))

    await writeFixture(globalDir, "opencode.jsonc", "{}\n")
    expect((await globalScope()).configFile).toBe(path.join(globalDir, "opencode.jsonc"))
  })

  it("resolveScope переключается флагом global", async () => {
    await isolate()
    expect((await resolveScope("/tmp/project", { global: false })).kind).toBe("project")
    expect((await resolveScope("/tmp/project", { global: true })).kind).toBe("global")
  })
})

describe("глобальный apply", () => {
  it("пишет артефакты в ~/.config/opencode, state — рядом с манифестом, проект не трогает", async () => {
    const { configHome } = await isolate()
    const source = await tempDir("harness-global-src-")
    await writeFixture(source, "demo/SKILL.md", "---\nname: demo\ndescription: Global demo\n---\n")
    await writeFixture(
      configHome,
      "harness/sources.yaml",
      `sources:\n  glocal:\n    type: local\n    path: ${JSON.stringify(source)}\n`,
    )

    /* Существующий user-конфиг: harness не должен создавать второй .jsonc */
    const globalDir = path.join(configHome, "opencode")
    await writeFixture(globalDir, "opencode.json", '{ "username": "vyacheslav" }\n')

    await writeFixture(
      configHome,
      "harness/harness.yaml",
      `version: 1
skills:
  - source: glocal
    name: demo
mcp:
  glocal-mcp:
    type: local
    command: [echo, hi]
permissions:
  - action: shell
    resource: "*"
    effect: ask
policies:
  - action: shell
    resource: "sudo *"
    effect: deny
agents:
  reviewer:
    description: Глобальное ревью
    mode: subagent
    body: |
      Проверь изменения.
instructions:
  blocks:
    global: |
      Правило: \`node --version\`.
config:
  model: global/model
`,
    )

    const projectDir = await tempDir("harness-global-project-")
    const scope = await resolveScope(projectDir, { global: true })
    const manifest = validateManifestText(await fs.readFile(scope.manifestFile, "utf8"))
    const catalog = await buildCatalog({ sourceFilter: ["glocal"] })
    const desired = buildDesiredState(scope, manifest, catalog)
    const state = emptyState()
    const plan = await computePlan(scope, desired, state)
    /* Существующий глобальный конфиг: отсутствующий ключ — create */
    expect(plan.items.filter((item) => item.action === "create")).toHaveLength(7)
    expect(plan.items.find((item) => item.target === "config:model")?.action).toBe("create")
    expect(plan.conflicts).toHaveLength(0)

    await applyDesired(scope, desired, plan, state)

    /* Скилл */
    expect(await fs.readFile(path.join(globalDir, "skills", "demo", "SKILL.md"), "utf8")).toContain("Global demo")
    /* Конфиг: user-ключ сохранён, наши ключи записаны, второй файл не создан */
    const config = JSON.parse(await fs.readFile(path.join(globalDir, "opencode.json"), "utf8"))
    expect(config.username).toBe("vyacheslav")
    expect(config.model).toBe("global/model")
    expect(config.permissions).toHaveLength(1)
    expect(config.policies).toHaveLength(1)
    await expect(fs.access(path.join(globalDir, "opencode.jsonc"))).rejects.toThrow()
    /* Агент и инструкции */
    expect(await fs.readFile(path.join(globalDir, "agents", "reviewer.md"), "utf8")).toContain("Глобальное ревью")
    expect(await fs.readFile(path.join(globalDir, "AGENTS.md"), "utf8")).toContain("<!-- harness:begin:global -->")
    /* State — рядом с глобальным манифестом */
    const globalState = await loadState(scope)
    expect(globalState.skills.demo?.mode).toBe("vendor")
    await fs.access(path.join(configHome, "harness", "state.json"))
    /* Проектный каталог не тронут */
    await expect(fs.access(path.join(projectDir, ".opencode"))).rejects.toThrow()
    await expect(fs.access(path.join(projectDir, ".harness"))).rejects.toThrow()
    await expect(fs.access(path.join(projectDir, ".gitignore"))).rejects.toThrow()

    /* Идемпотентность */
    const plan2 = await computePlan(scope, desired, globalState)
    expect(plan2.items.filter((item) => item.action !== "unchanged")).toHaveLength(0)

    /* Doctor: предупреждает о силе глобальных правил, но не падает */
    const checks = await runDoctor(scope)
    expect(checks.some((check) => check.level === "error")).toBe(false)
    expect(checks.some((check) => check.message.includes("глобальный скоуп"))).toBe(true)
    expect(checks.some((check) => check.level === "warn" && check.message.includes("перекрывают проектные"))).toBe(true)
  })
})
