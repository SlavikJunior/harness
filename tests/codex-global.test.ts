import { promises as fs } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { exportCodex } from "../src/targets/codex/export.js"
import { codexPaths } from "../src/targets/codex/paths.js"
import { parseTomlText } from "../src/targets/codex/toml.js"
import { resolveScope, type Scope } from "../src/scope.js"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"

/**
 * Global-scope Codex export: ~/.codex/config.toml правится точечно,
 * глобальные инструкции/агенты/скиллы — в своих Codex-путях.
 */

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

interface Fixture {
  project: string
  configHome: string
  home: string
  codexHome: string
  scope: Scope
}

const MANIFEST = `version: 1
skills:
  - source: codex-global
    name: demo
    mode: vendor
mcp:
  global-one:
    type: remote
    url: https://example.com/mcp
    headers:
      Authorization: "Bearer {env:GLOBAL_TOKEN}"
agents:
  reviewer:
    description: Глобальное ревью
    body: |
      Проверь изменения.
instructions:
  blocks:
    global: |
      Правило: \`node --version\`.
config:
  model: provider/model
`

async function setup(): Promise<Fixture> {
  const configHome = await tempDir("harness-codex-global-cfg-")
  const dataHome = await tempDir("harness-codex-global-data-")
  cleanup = isolateXdg(configHome, dataHome)

  const sourceDir = await tempDir("harness-codex-global-src-")
  await writeFixture(sourceDir, "demo/SKILL.md", "---\nname: demo\ndescription: Global\n---\nglobal\n")
  await writeFixture(
    configHome,
    "harness/sources.yaml",
    `sources:\n  codex-global:\n    type: local\n    path: ${sourceDir}\n`,
  )
  await writeFixture(configHome, "harness/harness.yaml", MANIFEST)
  await writeFixture(
    configHome,
    "opencode/AGENTS.md",
    "# OpenCode user text\n\n<!-- harness:begin:global -->\nПравило: `node --version`.\n<!-- harness:end:global -->\n",
  )

  const project = await tempDir("harness-codex-global-proj-")
  const home = await tempDir("harness-codex-global-home-")
  const codexHome = path.join(home, ".codex")
  const scope = await resolveScope(project, { global: true })
  return { project, configHome, home, codexHome, scope }
}

async function run(fixture: Fixture, options: { force?: boolean; dryRun?: boolean } = {}) {
  return exportCodex(fixture.scope, { environment: { home: fixture.home, codexHome: fixture.codexHome }, ...options })
}

describe("codex export (global)", () => {
  it("пишет config.toml точечно, сохраняя чужие ключи и MCP", async () => {
    const fixture = await setup()
    await writeFixture(
      fixture.codexHome,
      "config.toml",
      '# user config\nmodel = "gpt-6.1-sol"\n\n[mcp_servers.user]\ncommand = "echo"\n',
    )
    const result = await run(fixture)
    expect(result.errors).toEqual([])

    const text = await fs.readFile(path.join(fixture.codexHome, "config.toml"), "utf8")
    expect(text).toContain("# user config")
    expect(text).toContain('model = "gpt-6.1-sol"')
    expect(text).toContain("[mcp_servers.user]")
    expect(text).toContain("[mcp_servers.global-one]")
    expect(text).toContain('bearer_token_env_var = "GLOBAL_TOKEN"')

    const parsed = parseTomlText(text).value
    expect(parsed).toMatchObject({
      model: "gpt-6.1-sol",
      mcp_servers: { user: { command: "echo" }, "global-one": { url: "https://example.com/mcp" } },
    })

    /* Инструкции: target отсутствовал — полная копия, пользовательский текст сохранён */
    const instructions = await fs.readFile(path.join(fixture.codexHome, "AGENTS.md"), "utf8")
    expect(instructions).toContain("# OpenCode user text")
    expect(instructions).toContain("node --version")

    /* Скиллы и агенты — в Codex-путях, не в CODEX_HOME */
    expect(await fs.readFile(path.join(fixture.home, ".agents/skills/demo/SKILL.md"), "utf8")).toContain("global")
    const agent = parseTomlText(
      await fs.readFile(path.join(fixture.codexHome, "agents/reviewer.toml"), "utf8"),
    ).value
    expect(agent).toMatchObject({ name: "reviewer", description: "Глобальное ревью" })
  })

  it("сохраняет пользовательский AGENTS.md при managed-блоках", async () => {
    const fixture = await setup()
    await writeFixture(fixture.codexHome, "AGENTS.md", "# Codex user\n\nНе удаляй меня.\n")
    await run(fixture)
    const text = await fs.readFile(path.join(fixture.codexHome, "AGENTS.md"), "utf8")
    expect(text).toContain("# Codex user")
    expect(text).toContain("Не удаляй меня")
    expect(text).toContain("<!-- harness:begin:global -->")
  })

  it("чужой MCP/скилл — conflict без --force, с --force перезаписывается", async () => {
    const fixture = await setup()
    await writeFixture(
      fixture.codexHome,
      "config.toml",
      '[mcp_servers.global-one]\nurl = "https://user.example/mcp"\n',
    )
    await writeFixture(
      fixture.home,
      ".agents/skills/demo/SKILL.md",
      "---\nname: demo\ndescription: manual\n---\nmanual\n",
    )

    const conflict = await run(fixture)
    expect((await conflict.items.find((item) => item.name === "global-one"))?.status).toBe("conflict")
    expect((await conflict.items.find((item) => item.name === "demo" && item.section === "skills"))?.status).toBe(
      "conflict",
    )
    expect(await fs.readFile(path.join(fixture.codexHome, "config.toml"), "utf8")).toContain("user.example")

    const forced = await run(fixture, { force: true })
    expect((await forced.items.find((item) => item.name === "global-one"))?.status).toBe("forced")
    expect(await fs.readFile(path.join(fixture.codexHome, "config.toml"), "utf8")).toContain("example.com/mcp")
    expect(await fs.readFile(path.join(fixture.home, ".agents/skills/demo/SKILL.md"), "utf8")).toContain("global")
  })

  it("state и бэкапы живут в ~/.config/harness", async () => {
    const fixture = await setup()
    await run(fixture)
    const paths = codexPaths(fixture.scope, { home: fixture.home, codexHome: fixture.codexHome })
    expect(await fs.stat(paths.stateFile).then(() => true).catch(() => false)).toBe(true)
    expect(paths.stateFile.startsWith(fixture.configHome)).toBe(true)
    expect(paths.backupsDir.startsWith(fixture.configHome)).toBe(true)
    expect(await fs.stat(paths.backupsDir).then(() => true).catch(() => false)).toBe(true)
  })

  it("переносит AGENTS.md и все файлы из instructions", async () => {
    const fixture = await setup()
    const instructionsFile = path.join(fixture.configHome, "opencode/instructions.md")
    const claudeFile = path.join(fixture.home, ".claude/CLAUDE.md")
    await writeFixture(fixture.configHome, "opencode/instructions.md", "# Android instructions\n\nИспользуй Gradle.\n")
    await writeFixture(fixture.home, ".claude/CLAUDE.md", "# Harnest profile\n\nПроверяй архитектуру.\n")
    await writeFixture(
      fixture.configHome,
      "opencode/opencode.jsonc",
      JSON.stringify({ instructions: [instructionsFile, claudeFile] }, null, 2),
    )

    const first = await run(fixture)
    expect(first.errors).toEqual([])
    let text = await fs.readFile(path.join(fixture.codexHome, "AGENTS.md"), "utf8")
    expect(text).toContain("# OpenCode user text")
    expect(text).toContain("# Android instructions")
    expect(text).toContain("# Harnest profile")
    expect(text).toContain("<!-- harness:begin:opencode-AGENTS.md -->")
    expect(text).toContain("<!-- harness:begin:opencode-instructions.md -->")
    expect(text).toContain("<!-- harness:begin:opencode-CLAUDE.md -->")

    const second = await run(fixture)
    expect(second.written).toEqual([])
    expect((await second.items.find((entry) => entry.section === "instructions"))?.status).toBe("unchanged")

    await writeFixture(fixture.configHome, "opencode/instructions.md", "# Android instructions\n\nИспользуй Koin.\n")
    const updated = await run(fixture)
    expect(updated.written.length).toBeGreaterThan(0)
    text = await fs.readFile(path.join(fixture.codexHome, "AGENTS.md"), "utf8")
    expect(text).toContain("Используй Koin")
    expect(text).toContain("# Harnest profile")

    await writeFixture(
      fixture.configHome,
      "opencode/opencode.jsonc",
      JSON.stringify({ instructions: [instructionsFile] }, null, 2),
    )
    await run(fixture)
    text = await fs.readFile(path.join(fixture.codexHome, "AGENTS.md"), "utf8")
    expect(text).toContain("Используй Koin")
    expect(text).not.toContain("# Harnest profile")
  })
})
