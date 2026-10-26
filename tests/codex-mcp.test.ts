import { describe, expect, it } from "vitest"
import { mapMcpServer } from "../src/targets/codex/mcp.js"

/** MCP OpenCode → Codex: секреты только через env, небезопасные значения — skip. */

describe("mapMcpServer", () => {
  it("local: {env:VAR} → env_vars, литералы → env", () => {
    const result = mapMcpServer("demo", {
      type: "local",
      command: ["npx", "-y", "pkg"],
      environment: {
        TOKEN: "{env:TOKEN}",
        PLAIN: "value",
      },
    })
    expect(result.status).toBe("mapped")
    expect(result.value).toEqual({
      command: "npx",
      args: ["-y", "pkg"],
      env_vars: ["TOKEN"],
      env: { PLAIN: "value" },
    })
  })

  it("local: смешанная подстановка, {file:...} и секрет в аргументах → skip", () => {
    expect(
      mapMcpServer("x", {
        type: "local",
        command: ["npx", "pkg"],
        environment: { URL: "https://{env:HOST}/mcp" },
      }).status,
    ).toBe("skipped")
    expect(
      mapMcpServer("x", {
        type: "local",
        command: ["npx", "pkg"],
        environment: { FILE: "{file:./token}" },
      }).status,
    ).toBe("skipped")
    expect(
      mapMcpServer("x", {
        type: "local",
        command: ["npx", `ghp_${"a".repeat(36)}`],
      }).status,
    ).toBe("skipped")
  })

  it("remote: bearer, env-заголовок и статический заголовок", () => {
    const result = mapMcpServer("remote", {
      type: "remote",
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer {env:API_TOKEN}",
        "X-Tenant": "{env:TENANT}",
        "X-Static": "public",
      },
    })
    expect(result.status).toBe("approximate")
    expect(result.value).toEqual({
      url: "https://example.com/mcp",
      bearer_token_env_var: "API_TOKEN",
      env_http_headers: { "X-Tenant": "TENANT" },
      http_headers: { "X-Static": "public" },
    })
  })

  it("remote: literal token и URL с credentials → skip", () => {
    expect(
      mapMcpServer("x", {
        type: "remote",
        url: "https://example.com/mcp",
        headers: { Authorization: `Bearer ghp_${"a".repeat(36)}` },
      }).status,
    ).toBe("skipped")
    expect(
      mapMcpServer("x", {
        type: "remote",
        url: "https://user:pass@example.com/mcp",
      }).status,
    ).toBe("skipped")
  })
})
