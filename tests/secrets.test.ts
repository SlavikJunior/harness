import { describe, expect, it } from "vitest"
import { scanManifest, classifyValue, maskSecrets, maskText, looksHighEntropy, shannonEntropy } from "../src/secrets/scan.js"
import type { Manifest } from "../src/manifest/schema.js"

/** Аудит плейнтекст-секретов: детекция, пропуск ссылок и отсутствие утечки значения. */

function manifestOf(partial: Omit<Manifest, "version">): Manifest {
  return { version: 1, ...partial }
}

function paths(manifest: Manifest): string[] {
  return scanManifest(manifest).map((finding) => finding.path)
}

describe("scanManifest: известные форматы токенов", () => {
  it("находит ключ OpenAI/Anthropic в аргументе команды", () => {
    const manifest = manifestOf({
      mcp: {
        search: { type: "local", command: ["bunx", "mcp-search", "--api-key", "sk-proj-AbCdEfGhIjKlMnOp1234"] },
      },
    })
    const findings = scanManifest(manifest)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ path: "mcp.search.command[3]", kind: "pattern" })
    expect(findings[0]?.reason).toContain("OpenAI")
  })

  it("находит sk-ant-, GitHub, AWS и JWT в конфиге", () => {
    const manifest = manifestOf({
      config: {
        provider: {
          anthropic: { apiKey: "sk-ant-api03-PqRsTuVwXyZ0123456789" },
          github: { token: `ghp_${"a".repeat(36)}` },
          aws: { accessKeyId: "AKIAIOSFODNN7EXAMPLE" },
          session: { jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM" },
        },
      },
    })
    expect(paths(manifest)).toEqual([
      "config.provider.anthropic.apiKey",
      "config.provider.github.token",
      "config.provider.aws.accessKeyId",
      "config.provider.session.jwt",
    ])
  })

  it("находит ключ Google API и токен Telegram-бота", () => {
    const manifest = manifestOf({
      mcp: {
        notify: {
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            "X-Google": `AIza${"b".repeat(35)}`,
            "X-Bot": `123456789:${"c".repeat(35)}`,
          },
        },
      },
    })
    expect(paths(manifest)).toEqual(["mcp.notify.headers.X-Google", "mcp.notify.headers.X-Bot"])
  })
})

describe("scanManifest: эвристики", () => {
  it("находит учётные данные в URL", () => {
    const manifest = manifestOf({
      mcp: { db: { type: "remote", url: "https://user:pa55w0rd@db.example.com/mcp" } },
    })
    expect(scanManifest(manifest)[0]).toMatchObject({ path: "mcp.db.url", kind: "url-credentials" })
  })

  it("находит Bearer-токен в заголовке Authorization", () => {
    const manifest = manifestOf({
      mcp: { api: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer abc123def456" } } },
    })
    expect(scanManifest(manifest)[0]).toMatchObject({ path: "mcp.api.headers.Authorization", kind: "auth-header" })
  })

  it("находит значение под ключом с секретным именем", () => {
    const manifest = manifestOf({
      mcp: { gh: { type: "local", command: ["gh-mcp"], environment: { GITHUB_TOKEN: "plain-value" } } },
      config: { dbPassword: "hunter2", apiKey: "some-key" },
    })
    const kinds = scanManifest(manifest).map((finding) => finding.kind)
    expect(paths(manifest)).toEqual(["mcp.gh.environment.GITHUB_TOKEN", "config.dbPassword", "config.apiKey"])
    expect(kinds.every((kind) => kind === "keyword")).toBe(true)
  })

  it("обходит массивы в passthrough-конфиге", () => {
    const manifest = manifestOf({ config: { servers: [{ token: "value-123" }] } })
    expect(paths(manifest)).toEqual(["config.servers[0].token"])
  })
})

describe("scanManifest: негативы", () => {
  it("не флагает {env:VAR} и {file:...}", () => {
    const manifest = manifestOf({
      mcp: {
        api: {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer {env:MCP_TOKEN}" },
        },
        local: {
          type: "local",
          command: ["server", "--key", "{file:/run/secrets/api-key}"],
          environment: { API_KEY: "{env:API_KEY}" },
        },
      },
    })
    expect(scanManifest(manifest)).toEqual([])
  })

  it("не флагает заглушки", () => {
    const manifest = manifestOf({
      mcp: { x: { type: "local", command: ["x"], environment: { API_KEY: "changeme", TOKEN: "<your-token>" } } },
    })
    expect(scanManifest(manifest)).toEqual([])
  })

  it("не флагает обычные значения", () => {
    const manifest = manifestOf({
      mcp: {
        playwright: { type: "local", command: ["bunx", "@playwright/mcp"] },
        site: { type: "remote", url: "https://example.com/mcp", headers: { "X-Trace": "abc" } },
      },
      config: { model: "anthropic/claude-sonnet-5-5", theme: "dark" },
    })
    expect(scanManifest(manifest)).toEqual([])
  })
})

describe("scanManifest: высокая энтропия", () => {
  const unknownToken = "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW"

  it("находит токен без известного префикса", () => {
    const manifest = manifestOf({
      mcp: { custom: { type: "remote", url: "https://example.com/mcp", headers: { "X-Key": unknownToken } } },
    })
    expect(scanManifest(manifest)[0]).toMatchObject({ path: "mcp.custom.headers.X-Key", kind: "entropy" })
  })

  it("не флагает пути, kebab-case, git sha и UUID", () => {
    const values = [
      "packages/docs/getting-started-with-tokens.mdx",
      "eslint-plugin-react-hooks-2024",
      "da39a3ee5e6b4b0d3255bfef95601890afd80709",
      "123e4567-e89b-12d3-a456-426614174000",
      "anthropic/claude-sonnet-5-5",
      "https://example.com/mcp",
    ]
    for (const value of values) expect(classifyValue(undefined, value), value).toBeUndefined()
  })

  it("порог энтропии и требования к составу строки", () => {
    expect(shannonEntropy("aaaa")).toBe(0)
    expect(shannonEntropy("abcd")).toBe(2)
    expect(looksHighEntropy(unknownToken)).toBe(true)
    expect(looksHighEntropy("shortToken1")).toBe(false)
    expect(looksHighEntropy(unknownToken.toLowerCase())).toBe(false)
    expect(looksHighEntropy(unknownToken.replace(/\d/g, "x"))).toBe(false)
  })

  it("секретное имя ключа важнее энтропии (одна находка)", () => {
    const manifest = manifestOf({ config: { apiKey: unknownToken } })
    const findings = scanManifest(manifest)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe("keyword")
  })

  it("маскирует токен без известного префикса", () => {
    expect(maskText(unknownToken, "X-Key")).toBe("•••")
  })
})

describe("утечка значения", () => {
  it("в находке нет самого секрета", () => {
    const secret = `sk-ant-api03-${"z".repeat(24)}`
    const manifest = manifestOf({ config: { apiKey: secret } })
    const findings = scanManifest(manifest)
    expect(findings).toHaveLength(1)
    expect(JSON.stringify(findings)).not.toContain(secret)
  })

  it("одно поле — одна находка, даже если подходит несколько правил", () => {
    const manifest = manifestOf({
      mcp: { x: { type: "local", command: ["x"], environment: { API_KEY: "sk-proj-AbCdEfGhIjKlMnOp1234" } } },
    })
    const findings = scanManifest(manifest)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe("pattern")
  })
})

describe("classifyValue", () => {
  it("распознаёт схему авторизации", () => {
    expect(classifyValue("Authorization", "Basic dXNlcjpwYXNz")).toMatchObject({ kind: "auth-header" })
    expect(classifyValue("X-Trace", "Basic abc")).toBeUndefined()
  })

  it("не считает ссылку секретом", () => {
    expect(classifyValue("apiKey", "{env:KEY}")).toBeUndefined()
  })
})

describe("маскировка для вывода", () => {
  it("скрывает секретные значения, оставляя обычные", () => {
    const masked = maskSecrets({ model: "test/model", apiKey: "sk-proj-AbCdEfGhIjKlMnOp1234" })
    expect(masked).toEqual({ model: "test/model", apiKey: "•••" })
  })

  it("скрывает вложенные значения и элементы массивов", () => {
    const masked = maskSecrets({ provider: { token: "plain-token" }, list: ["ok", `ghp_${"a".repeat(36)}`] })
    expect(masked).toEqual({ provider: { token: "•••" }, list: ["ok", "•••"] })
  })

  it("в URL с кредами оставляет схему и хост", () => {
    expect(maskText("https://user:pa55@db.example.com/mcp", "url")).toBe("https://•••@db.example.com/mcp")
    expect(maskText("https://example.com/mcp", "url")).toBe("https://example.com/mcp")
  })

  it("не трогает {env:VAR}", () => {
    expect(maskText("Bearer {env:TOKEN}", "Authorization")).toBe("Bearer {env:TOKEN}")
  })
})
