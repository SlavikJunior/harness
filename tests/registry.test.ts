import { describe, expect, it } from "vitest"
import { tempDir } from "./helpers.js"
import { HarnessError } from "../src/core/errors.js"
import {
  compareVersions,
  createRegistryClient,
  draftFromRegistry,
  packageCommand,
  parseSearchResponse,
  parseServerResponse,
  registryServerView,
  sanitizeMcpName,
} from "../src/registry/index.js"
import type { RegistryServer } from "../src/registry/types.js"

/**
 * MCP-каталог: маппинг registry-записей в V2, секреты → {env:VAR},
 * кэш с TTL и stale-фолбэком. Сеть подменяется fetch-фикстурой.
 */

function registryServer(overrides: Partial<RegistryServer> = {}): RegistryServer {
  return {
    name: "io.example/demo",
    title: "Demo",
    description: "Demo MCP server",
    version: "1.2.3",
    status: "active",
    isLatest: true,
    packages: [],
    remotes: [],
    ...overrides,
  }
}

function entry(server: RegistryServer): unknown {
  return {
    server: {
      name: server.name,
      version: server.version,
      ...(server.title === undefined ? {} : { title: server.title }),
      ...(server.description === undefined ? {} : { description: server.description }),
      ...(server.repository === undefined ? {} : { repository: { url: server.repository, source: "github" } }),
      packages: server.packages.map((pkg) => ({
        registryType: pkg.registryType,
        identifier: pkg.identifier,
        ...(pkg.version === undefined ? {} : { version: pkg.version }),
        ...(pkg.runtimeHint === undefined ? {} : { runtimeHint: pkg.runtimeHint }),
        runtimeArguments: pkg.runtimeArguments.map((argument) => ({
          ...(argument.type === undefined ? {} : { type: argument.type }),
          ...(argument.name === undefined ? {} : { name: argument.name }),
          ...(argument.value === undefined ? {} : { value: argument.value }),
        })),
        packageArguments: pkg.packageArguments.map((argument) => ({
          ...(argument.type === undefined ? {} : { type: argument.type }),
          ...(argument.name === undefined ? {} : { name: argument.name }),
          ...(argument.value === undefined ? {} : { value: argument.value }),
        })),
        environmentVariables: pkg.environmentVariables,
      })),
      remotes: server.remotes,
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: server.status,
        isLatest: server.isLatest,
        ...(server.updatedAt === undefined ? {} : { updatedAt: server.updatedAt }),
      },
    },
  }
}

interface Call {
  url: string
}

function fakeFetch(handler: (url: string) => unknown, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push({ url })
    const result = handler(url)
    if (result instanceof Error) throw result
    if (typeof result === "object" && result !== null && "status" in result) {
      const response = result as { status: number; body?: unknown }
      return new Response(response.body === undefined ? "" : JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

function searchBody(servers: RegistryServer[], nextCursor?: string): unknown {
  return {
    servers: servers.map(entry),
    metadata: { ...(nextCursor === undefined ? {} : { nextCursor }) },
  }
}

describe("маппинг registry → V2", () => {
  it("npm: runtimeArgs, пин версии, env: default/secret/required", () => {
    const server = registryServer({
      packages: [
        {
          registryType: "npm",
          identifier: "remote-filesystem-mcp-server",
          version: "0.1.3",
          runtimeHint: "npx",
          runtimeArguments: [
            { type: "positional", name: undefined, value: "-y", valueHint: undefined, isRequired: undefined },
          ],
          packageArguments: [
            { type: "named", name: "--root", value: "/tmp", valueHint: undefined, isRequired: undefined },
          ],
          environmentVariables: [
            { name: "GCS_BUCKET", isRequired: true },
            { name: "GCS_PRIVATE_KEY", isSecret: true },
            { name: "GCS_MAKE_PUBLIC", default: "false" },
            { name: "OPTIONAL_FLAG" },
          ],
        },
      ],
    })
    const draft = draftFromRegistry(server)
    expect(draft.transport).toBe("local")
    expect(draft.name).toBe("demo")
    expect(draft.server).toEqual({
      type: "local",
      command: ["npx", "-y", "remote-filesystem-mcp-server@0.1.3", "--root", "/tmp"],
      environment: {
        GCS_BUCKET: "{env:GCS_BUCKET}",
        GCS_PRIVATE_KEY: "{env:GCS_PRIVATE_KEY}",
        GCS_MAKE_PUBLIC: "false",
      },
    })
    expect(draft.requiredEnv).toEqual(["GCS_BUCKET", "GCS_PRIVATE_KEY"])
    expect(draft.warnings.some((warning) => warning.includes("OPTIONAL_FLAG"))).toBe(true)
    expect(JSON.stringify(draft)).not.toContain("PRIVATE KEY")
  })

  it("pypi: uvx и пин через ==", () => {
    const server = registryServer({
      packages: [
        {
          registryType: "pypi",
          identifier: "files-com-mcp",
          version: "1.0.34",
          runtimeArguments: [],
          packageArguments: [],
          environmentVariables: [{ name: "FILES_COM_API_KEY", isRequired: true, isSecret: true }],
        },
      ],
    })
    const draft = draftFromRegistry(server)
    expect(draft.server).toEqual({
      type: "local",
      command: ["uvx", "files-com-mcp==1.0.34"],
      environment: { FILES_COM_API_KEY: "{env:FILES_COM_API_KEY}" },
    })
    expect(draft.requiredEnv).toEqual(["FILES_COM_API_KEY"])
  })

  it("oci: docker run -i --rm и тег версии; cargo предупреждает про установку", () => {
    expect(
      packageCommand(
        registryServer(),
        {
          registryType: "oci",
          identifier: "ghcr.io/example/demo",
          version: "2.0.0",
          runtimeArguments: [],
          packageArguments: [],
          environmentVariables: [],
        },
        [],
      ),
    ).toEqual(["docker", "run", "-i", "--rm", "ghcr.io/example/demo:2.0.0"])

    const warnings: string[] = []
    expect(
      packageCommand(
        registryServer(),
        {
          registryType: "cargo",
          identifier: "demo-server",
          version: "0.1.0",
          runtimeArguments: [],
          packageArguments: [],
          environmentVariables: [],
        },
        warnings,
      ),
    ).toEqual(["demo-server"])
    expect(warnings[0]).toContain("cargo install")
  })

  it("remote: шаблон секретного заголовка → {env:VAR}, обычный заголовок сохраняется", () => {
    const server = registryServer({
      remotes: [
        {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: [
            {
              name: "Authorization",
              isRequired: true,
              isSecret: true,
              value: "Bearer {smithery_api_key}",
              description: "token",
            },
            { name: "X-Tenant", value: "public-tenant" },
            { name: "X-Optional" },
          ],
        },
      ],
    })
    const draft = draftFromRegistry(server)
    expect(draft.server).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer {env:SMITHERY_API_KEY}",
        "X-Tenant": "public-tenant",
      },
    })
    expect(draft.requiredEnv).toEqual(["SMITHERY_API_KEY"])
  })

  it("секретный заголовок без шаблона и без значения получает env по имени", () => {
    const server = registryServer({
      remotes: [
        {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: [{ name: "X-Api-Key", isSecret: true, isRequired: true }],
        },
      ],
    })
    const draft = draftFromRegistry(server)
    expect(draft.server).toMatchObject({ headers: { "X-Api-Key": "{env:X_API_KEY}" } })
    expect(draft.requiredEnv).toEqual(["X_API_KEY"])
  })

  it("секретный заголовок с литеральным токеном сохраняет схему авторизации", () => {
    const server = registryServer({
      remotes: [
        {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: [
            { name: "Authorization", isSecret: true, value: `Bearer ghp_${"a".repeat(36)}` },
          ],
        },
      ],
    })
    const draft = draftFromRegistry(server)
    expect(draft.server).toMatchObject({ headers: { Authorization: "Bearer {env:AUTHORIZATION}" } })
    expect(JSON.stringify(draft)).not.toContain("ghp_")
  })

  it("по умолчанию remote важнее пакета; --package выбирает пакет; --remote без remote — ошибка", () => {
    const withBoth = registryServer({
      remotes: [{ type: "streamable-http", url: "https://example.com/mcp", headers: [] }],
      packages: [
        {
          registryType: "npm",
          identifier: "demo",
          version: "1.0.0",
          runtimeArguments: [],
          packageArguments: [],
          environmentVariables: [],
        },
      ],
    })
    expect(draftFromRegistry(withBoth).transport).toBe("remote")
    expect(draftFromRegistry(withBoth, { packageType: "npm" }).transport).toBe("local")
    expect(() => draftFromRegistry(registryServer(), { remote: true })).toThrow(HarnessError)
  })

  it("неподдерживаемый пакет и имя — понятные ошибки", () => {
    const mcpb = registryServer({
      packages: [
        {
          registryType: "mcpb",
          identifier: "demo.mcpb",
          version: "1.0.0",
          runtimeArguments: [],
          packageArguments: [],
          environmentVariables: [],
        },
      ],
    })
    expect(() => draftFromRegistry(mcpb)).toThrow(/поддержива/)
    expect(() => draftFromRegistry(registryServer(), { name: "bad/name" })).toThrow(/Недопустимое имя/)
    expect(sanitizeMcpName("ai.smithery/Hint-Services-obsidian-github-mcp")).toBe(
      "hint-services-obsidian-github-mcp",
    )
  })

  it("отказывается копировать секрет из аргументов и URL", () => {
    const secret = `ghp_${"a".repeat(36)}`
    const withArg = registryServer({
      packages: [
        {
          registryType: "npm",
          identifier: "demo",
          version: "1.0.0",
          runtimeArguments: [{ type: "positional", name: undefined, value: secret, valueHint: undefined, isRequired: undefined }],
          packageArguments: [],
          environmentVariables: [],
        },
      ],
    })
    expect(() => draftFromRegistry(withArg)).toThrow(/похожее на секрет/)

    const withCredentials = registryServer({
      remotes: [{ type: "streamable-http", url: "https://user:pass@example.com/mcp", headers: [] }],
    })
    expect(() => draftFromRegistry(withCredentials)).toThrow(/учётные данные/)
  })

  it("JSON-view не содержит заголовков и env", () => {
    const view = registryServerView(
      registryServer({
        remotes: [
          { type: "streamable-http", url: "https://example.com", headers: [{ name: "Authorization", value: "secret" }] },
        ],
      }),
    )
    expect(view.remotes).toEqual([{ type: "streamable-http", url: "https://example.com" }])
    expect(JSON.stringify(view)).not.toContain("secret")
  })

  it("сравнение версий числовое и нормализация ответов реестра", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0)
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0)
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBeLessThan(0)
  })
})

describe("парсер ответов", () => {
  it("пропускает записи неизвестного формата, но не роняет весь ответ", () => {
    const parsed = parseSearchResponse({
      servers: [entry(registryServer()), { garbage: true }],
      metadata: {},
    })
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.invalid).toBe(1)
  })

  it("latest-эндпоинт возвращает один сервер", () => {
    const parsed = parseServerResponse(entry(registryServer()))
    expect(parsed.server.name).toBe("io.example/demo")
    expect(parsed.server.isLatest).toBe(true)
  })

  it("неожиданный ответ — HarnessError", () => {
    expect(() => parseSearchResponse({ unexpected: [] })).toThrow(HarnessError)
    expect(() => parseServerResponse({ nope: true })).toThrow(HarnessError)
  })
})

function searchable(overrides: Partial<RegistryServer> = {}): RegistryServer {
  return registryServer({
    remotes: [{ type: "streamable-http", url: "https://example.com/mcp", headers: [] }],
    ...overrides,
  })
}

describe("клиент реестра и кэш", () => {
  it("поиск фильтрует, дедуплицирует версии и кэшируется до TTL", async () => {
    const root = await tempDir("harness-registry-")
    const calls: Call[] = []
    let clock = Date.parse("2026-10-26T00:00:00Z")
    const servers = [
      searchable({ name: "io.example/demo", version: "1.0.0", isLatest: false }),
      searchable({ name: "io.example/demo", version: "1.2.0", isLatest: true }),
      searchable({ name: "io.example/other", version: "1.0.0", description: "demo too" }),
      searchable({ name: "io.example/deleted", version: "1.0.0", status: "deleted" }),
    ]
    const client = createRegistryClient({
      cacheRoot: root,
      now: () => clock,
      fetchImpl: fakeFetch(() => searchBody(servers), calls),
    })

    const first = await client.search("demo")
    expect(first.source).toBe("network")
    expect(first.servers.map((server) => server.name)).toEqual(["io.example/demo", "io.example/other"])
    expect(first.servers[0]?.version).toBe("1.2.0")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("search=demo")

    const second = await client.search("demo")
    expect(second.source).toBe("cache")
    expect(calls).toHaveLength(1)

    clock += 25 * 60 * 60 * 1000
    const third = await client.search("demo")
    expect(third.source).toBe("network")
    expect(calls).toHaveLength(2)

    await client.search("demo")
    expect(calls).toHaveLength(2)
  })

  it("--refresh игнорирует кэш", async () => {
    const root = await tempDir("harness-registry-")
    const calls: Call[] = []
    const fetchImpl = fakeFetch(() => searchBody([searchable()]), calls)
    const first = createRegistryClient({ cacheRoot: root, fetchImpl })
    await first.search("demo")
    const refreshed = createRegistryClient({ cacheRoot: root, fetchImpl, refresh: true })
    await refreshed.search("demo")
    expect(calls).toHaveLength(2)
  })

  it("сеть упала → stale-кэш с предупреждением; без кэша — ошибка", async () => {
    const root = await tempDir("harness-registry-")
    const working = createRegistryClient({
      cacheRoot: root,
      fetchImpl: fakeFetch(() => searchBody([searchable()])),
    })
    await working.search("demo")

    const failing = createRegistryClient({
      cacheRoot: root,
      refresh: true,
      fetchImpl: fakeFetch(() => new Error("ECONNREFUSED")),
    })
    const stale = await failing.search("demo")
    expect(stale.source).toBe("stale-cache")
    expect(stale.warning).toContain("кэш")
    expect(stale.servers).toHaveLength(1)

    const empty = createRegistryClient({
      cacheRoot: await tempDir("harness-registry-"),
      fetchImpl: fakeFetch(() => new Error("ECONNREFUSED")),
    })
    await expect(empty.search("demo")).rejects.toBeInstanceOf(HarnessError)
  })

  it("get: latest и конкретная версия, 404 — ошибка, deleted — ошибка", async () => {
    const root = await tempDir("harness-registry-")
    const calls: Call[] = []
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("versions/9.9.9")) return { status: 404 }
      return entry(searchable({ version: url.includes("versions/latest") ? "2.0.0" : "1.5.0" }))
    }, calls)
    const client = createRegistryClient({ cacheRoot: root, fetchImpl })

    const latest = await client.get("io.example/demo")
    expect(latest.server.version).toBe("2.0.0")
    expect(calls[0]?.url).toContain("io.example%2Fdemo/versions/latest")

    const pinned = await client.get("io.example/demo", "1.5.0")
    expect(pinned.server.version).toBe("1.5.0")
    await expect(client.get("io.example/demo", "9.9.9")).rejects.toThrow(/404/)

    const deleted = createRegistryClient({
      cacheRoot: await tempDir("harness-registry-"),
      fetchImpl: fakeFetch(() => entry(searchable({ status: "deleted" }))),
    })
    await expect(deleted.get("io.example/gone")).rejects.toThrow(/удалён/)
  })

  it("если параметр search не поддержан — fallback на постраничную загрузку", async () => {
    const root = await tempDir("harness-registry-")
    const calls: Call[] = []
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("search=")) return { status: 400 }
      return searchBody([searchable(), searchable({ name: "io.example/other", title: "Other", description: "unrelated" })])
    }, calls)
    const client = createRegistryClient({ cacheRoot: root, fetchImpl })
    const result = await client.search("demo")
    expect(result.servers.map((server) => server.name)).toEqual(["io.example/demo"])
    expect(calls).toHaveLength(2)
  })

  it("пагинация по metadata.nextCursor", async () => {
    const root = await tempDir("harness-registry-")
    const calls: Call[] = []
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("cursor=page2")) return searchBody([searchable({ name: "io.example/second" })])
      return searchBody([searchable()], "page2")
    }, calls)
    const client = createRegistryClient({ cacheRoot: root, fetchImpl })
    const result = await client.search("demo")
    expect(result.servers.map((server) => server.name)).toEqual(["io.example/demo", "io.example/second"])
    expect(calls).toHaveLength(2)
  })
})
