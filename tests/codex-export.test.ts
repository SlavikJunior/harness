import { promises as fs } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { exportCodex } from "../src/targets/codex/export.js"
import { listCodexBackups, restoreCodexBackup } from "../src/targets/codex/backup.js"
import { codexPaths } from "../src/targets/codex/paths.js"
import { parseTomlText } from "../src/targets/codex/toml.js"
import { codexStrictFailure } from "../src/targets/codex/types.js"
import { projectScope, type Scope } from "../src/scope.js"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"

/**
 * Project-scope Codex export: skills/instructions/MCP/agents, идемпотентность,
 * конфликты, --force, dry-run и undo.
 */

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

interface Fixture {
  project: string
  sourceDir: string
  home: string
  codexHome: string
  scope: Scope
}

function manifest(options: { body?: string; block?: string; mcp?: boolean; extra?: string } = {}): string {
  return `version: 1
skills:
  - source: codex-local
    name: demo
    mode: vendor
${options.mcp === false ? "" : `mcp:
  local-one:
    type: local
    command: [npx, -y, pkg]
    environment:
      TOKEN: "{env:LOCAL_TOKEN}"
      PLAIN: value
  remote-one:
    type: remote
    url: https://example.com/mcp
    headers:
      Authorization: "Bearer {env:REMOTE_TOKEN}"
      X-Static: hello
`}agents:
  reviewer:
    description: Ревью
    mode: subagent
    body: |
      ${options.body ?? "Проверь изменения."}
instructions:
  blocks:
    build: |
      ${options.block ?? "Сборка: `./gradlew test`."}
config:
  model: provider/model
  theme: dark
${options.extra ?? ""}`
}

async function setup(): Promise<Fixture> {
  const configHome = await tempDir("harness-codex-cfg-")
  const dataHome = await tempDir("harness-codex-data-")
  cleanup = isolateXdg(configHome, dataHome)

  const sourceDir = await tempDir("harness-codex-src-")
  await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: Demo\n---\nv1\n")
  await writeFixture(
    configHome,
    "harness/sources.yaml",
    `sources:\n  codex-local:\n    type: local\n    path: ${sourceDir}\n`,
  )
  const project = await tempDir("harness-codex-proj-")
  await writeFixture(project, "harness.yaml", manifest())
  const home = await tempDir("harness-codex-home-")
  const codexHome = path.join(home, ".codex")
  return { project, sourceDir, home, codexHome, scope: projectScope(project) }
}

async function run(fixture: Fixture, options: { dryRun?: boolean; force?: boolean } = {}) {
  return exportCodex(fixture.scope, { environment: { home: fixture.home, codexHome: fixture.codexHome }, ...options })
}

async function item(result: Awaited<ReturnType<typeof run>>, name: string) {
  return result.items.find((entry) => entry.name === name)
}

describe("codex export (project)", () => {
  it("переносит скилл, инструкции, MCP и агента; повторный запуск идемпотентен", async () => {
    const fixture = await setup()
    const first = await run(fixture)
    expect(first.errors).toEqual([])
    expect(first.written.length).toBeGreaterThan(0)

    const skill = await fs.readFile(path.join(fixture.project, ".agents/skills/demo/SKILL.md"), "utf8")
    expect(skill).toContain("v1")

    const config = parseTomlText(
      await fs.readFile(path.join(fixture.project, ".codex/config.toml"), "utf8"),
    ).value
    expect(config).toMatchObject({
      mcp_servers: {
        "local-one": {
          command: "npx",
          args: ["-y", "pkg"],
          env_vars: ["LOCAL_TOKEN"],
          env: { PLAIN: "value" },
        },
        "remote-one": {
          url: "https://example.com/mcp",
          bearer_token_env_var: "REMOTE_TOKEN",
          http_headers: { "X-Static": "hello" },
        },
      },
    })

    const agent = parseTomlText(
      await fs.readFile(path.join(fixture.project, ".codex/agents/reviewer.toml"), "utf8"),
    ).value
    expect(agent).toMatchObject({ name: "reviewer", description: "Ревью" })

    const instructions = await fs.readFile(path.join(fixture.project, "AGENTS.md"), "utf8")
    expect(instructions).toContain("<!-- harness:begin:build -->")
    expect(instructions).toContain("./gradlew test")

    const second = await run(fixture)
    expect(second.errors).toEqual([])
    expect(second.written).toEqual([])
    expect(second.removed).toEqual([])
    expect((await item(second, "demo"))?.status).toBe("unchanged")
  })

  it("не предупреждает о trust, если проект уже trusted", async () => {
    const fixture = await setup()
    await writeFixture(
      fixture.codexHome,
      "config.toml",
      `[projects.${JSON.stringify(fixture.project)}]\ntrust_level = "trusted"\n`,
    )
    const result = await run(fixture)
    expect(result.items.find((item) => item.name === "project-trust")).toBeUndefined()
  })

  it("обновляет изменённый манифест и источник скилла", async () => {
    const fixture = await setup()
    await run(fixture)
    await writeFixture(fixture.sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: Demo\n---\nv2\n")
    await writeFixture(
      fixture.project,
      "harness.yaml",
      manifest({ body: "Вторая версия.", block: "Сборка: `./gradlew testDebug`." }),
    )

    const result = await run(fixture)
    expect(result.written.length).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(fixture.project, ".agents/skills/demo/SKILL.md"), "utf8")).toContain("v2")
    expect(await fs.readFile(path.join(fixture.project, "AGENTS.md"), "utf8")).toContain("testDebug")
    expect(
      await fs.readFile(path.join(fixture.project, ".codex/agents/reviewer.toml"), "utf8"),
    ).toContain("Вторая версия")
  })

  it("не перезаписывает ручную правку без --force", async () => {
    const fixture = await setup()
    await run(fixture)
    const agentFile = path.join(fixture.project, ".codex/agents/reviewer.toml")
    const manual = 'name = "reviewer"\ndescription = "manual"\ndeveloper_instructions = "manual"\n'
    await fs.writeFile(agentFile, manual, "utf8")
    await writeFixture(fixture.project, "harness.yaml", manifest({ body: "Новая версия." }))

    const conflict = await run(fixture)
    expect(conflict.errors).toEqual([])
    expect((await item(conflict, "reviewer"))?.status).toBe("conflict")
    expect(codexStrictFailure(conflict)).toBe(true)
    expect(await fs.readFile(agentFile, "utf8")).toBe(manual)

    const forced = await run(fixture, { force: true })
    expect((await item(forced, "reviewer"))?.status).toBe("forced")
    expect(await fs.readFile(agentFile, "utf8")).toContain("Новая версия")
  })

  it("dry-run не пишет и не создаёт снапшотов", async () => {
    const fixture = await setup()
    await run(fixture)
    await writeFixture(fixture.project, "harness.yaml", manifest({ body: "Только в dry-run." }))
    const before = await fs.readFile(path.join(fixture.project, ".codex/agents/reviewer.toml"), "utf8")
    const backups = (await listCodexBackups(codexPaths(fixture.scope, { home: fixture.home, codexHome: fixture.codexHome }).backupsDir)).length

    const dry = await run(fixture, { dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.written).toEqual([])
    expect(await fs.readFile(path.join(fixture.project, ".codex/agents/reviewer.toml"), "utf8")).toBe(before)
    expect(
      (await listCodexBackups(codexPaths(fixture.scope, { home: fixture.home, codexHome: fixture.codexHome }).backupsDir)).length,
    ).toBe(backups)
  })

  it("удаляет state-owned артефакты, которых больше нет в манифесте, и откатывает это", async () => {
    const fixture = await setup()
    await run(fixture)
    await writeFixture(
      fixture.project,
      "harness.yaml",
      "version: 1\nconfig:\n  model: provider/model\n  theme: dark\n",
    )

    const removed = await run(fixture)
    expect(removed.removed.length).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(fixture.project, ".codex/config.toml"), "utf8")).not.toContain("local-one")
    expect(await fs.stat(path.join(fixture.project, ".agents/skills/demo")).catch(() => undefined)).toBeUndefined()

    const undo = await restoreCodexBackup(
      fixture.scope,
      codexPaths(fixture.scope, { home: fixture.home, codexHome: fixture.codexHome }).backupsDir,
      { environment: { home: fixture.home, codexHome: fixture.codexHome } },
    )
    expect(undo.restored).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(fixture.project, ".agents/skills/demo/SKILL.md"), "utf8")).toContain("v1")
    expect(await fs.readFile(path.join(fixture.project, ".codex/config.toml"), "utf8")).toContain("local-one")
  })

  it("удаляет managed-блок, сохраняя пользовательский текст AGENTS.md", async () => {
    const fixture = await setup()
    await run(fixture)
    const agentsFile = path.join(fixture.project, "AGENTS.md")
    const current = await fs.readFile(agentsFile, "utf8")
    await fs.writeFile(agentsFile, `# Мой текст\n\n${current}`, "utf8")
    await writeFixture(fixture.project, "harness.yaml", "version: 1\n")

    const removed = await run(fixture)
    expect(removed.errors).toEqual([])
    const text = await fs.readFile(agentsFile, "utf8")
    expect(text).toContain("# Мой текст")
    expect(text).not.toContain("<!-- harness:begin:build -->")
  })

  it("добавляет live-only артефакты, а manifest-only их отключает", async () => {
    const fixture = await setup()
    await writeFixture(fixture.project, ".opencode/skills/manual/SKILL.md", "---\nname: manual\n---\n")
    await writeFixture(
      fixture.project,
      ".opencode/agents/manual.md",
      "---\ndescription: manual\n---\nmanual body\n",
    )
    await writeFixture(
      fixture.project,
      ".opencode/opencode.jsonc",
      '{\n  "mcp": { "servers": { "live-mcp": { "type": "local", "command": ["echo", "live"] } } }\n}\n',
    )
    const withLive = await run(fixture)
    expect((await item(withLive, "manual"))?.status).toBe("approximate")
    expect(await fs.stat(path.join(fixture.project, ".agents/skills/manual")).catch(() => undefined)).toBeDefined()
    expect(await fs.stat(path.join(fixture.project, ".codex/agents/manual.toml")).catch(() => undefined)).toBeDefined()
    expect(await fs.readFile(path.join(fixture.project, ".codex/config.toml"), "utf8")).toContain("live-mcp")

    await fs.rm(path.join(fixture.project, ".agents/skills/manual"), { recursive: true, force: true })
    await fs.rm(path.join(fixture.project, ".codex/agents/manual.toml"), { force: true })
    await fs.rm(path.join(fixture.project, ".harness/codex-state.json"), { force: true })
    const only = await exportCodex(fixture.scope, {
      manifestOnly: true,
      environment: { home: fixture.home, codexHome: fixture.codexHome },
    })
    expect(await item(only, "manual")).toBeUndefined()
    expect(only.items.some((entry) => entry.name === "live-mcp")).toBe(false)
  })
})
