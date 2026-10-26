import { describe, expect, it } from "vitest"
import { HarnessError } from "../src/core/errors.js"
import {
  applyMcpChanges,
  mcpServerValue,
  parseTomlText,
  renderMcpTable,
  renderAgentToml,
} from "../src/targets/codex/toml.js"

/** TOML-редактор: managed-таблицы MCP не должны трогать чужие ключи/комментарии. */

describe("Codex TOML", () => {
  it("добавляет MCP-таблицу, сохраняя чужие ключи и комментарии", () => {
    const original = `# user config
model = "gpt-6.1-sol"
approval_policy = "on-request"

[mcp_servers.existing]
command = "echo"

[other]
key = "value"
`
    const doc = parseTomlText(original)
    const next = applyMcpChanges(doc, {
      remove: [],
      append: {
        demo: {
          command: "npx",
          args: ["-y", "pkg"],
          env_vars: ["TOKEN"],
          env: { PLAIN: "value" },
        },
      },
    })
    expect(next).toContain("# user config")
    expect(next).toContain('model = "gpt-6.1-sol"')
    expect(next).toContain('approval_policy = "on-request"')
    expect(next).toContain("[mcp_servers.existing]")
    expect(next).toContain("[other]")
    expect(next).toContain("[mcp_servers.demo]")
    expect(next).toContain('args = ["-y", "pkg"]')
    expect(next).toContain('env_vars = ["TOKEN"]')
    expect(parseTomlText(next).value).toMatchObject({
      mcp_servers: {
        demo: { command: "npx", args: ["-y", "pkg"], env_vars: ["TOKEN"], env: { PLAIN: "value" } },
      },
    })
  })

  it("удаляет базовую таблицу и вложенные таблицы сервера, не трогая соседей", () => {
    const original = `[mcp_servers.a]
command = "a"

[mcp_servers.a.env]
TOKEN = "x"

[mcp_servers.b]
command = "b"
`
    const doc = parseTomlText(original)
    const next = applyMcpChanges(doc, { remove: ["a"], append: {} })
    expect(mcpServerValue(parseTomlText(next), "a")).toBeUndefined()
    expect(mcpServerValue(parseTomlText(next), "b")).toEqual({ command: "b" })
    expect(next).not.toContain("TOKEN")
  })

  it("inline-структура mcp_servers — понятная ошибка", () => {
    const doc = parseTomlText('mcp_servers = { a = { command = "x" } }\n')
    expect(() => applyMcpChanges(doc, { remove: ["a"], append: {} })).toThrow(HarnessError)
  })

  it("рендерит строки и ключи с точками/дефисами", () => {
    const block = renderMcpTable("a.b-c", {
      command: "npx",
      env: { "X-Token": "value" },
    })
    expect(block).toContain('[mcp_servers."a.b-c"]')
    expect(block).toContain('env = { X-Token = "value" }')
    expect(parseTomlText(block).value).toMatchObject({
      mcp_servers: { "a.b-c": { command: "npx", env: { "X-Token": "value" } } },
    })
    const agent = renderAgentToml("reviewer", "desc", "line1\nline2")
    expect(parseTomlText(agent).value).toMatchObject({
      name: "reviewer",
      description: "desc",
      developer_instructions: "line1\nline2",
    })
  })
})
