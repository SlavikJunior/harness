#!/usr/bin/env node
/**
 * Кросс-платформенный CI-смоук: init-манифест вручную → plan --json → apply →
 * doctor --strict → повторный plan. Проверяет ссылку reference-скилла
 * (на Windows — junction), permissions и управляемый блок AGENTS.md.
 */
import { existsSync, promises as fs } from "node:fs"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "dist", "cli", "index.js")

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-ci-"))
process.env.XDG_CONFIG_HOME = path.join(temp, "config")
process.env.XDG_DATA_HOME = path.join(temp, "data")

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf8")
}

function run(project, args, expectedStatus) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: "utf8",
    env: process.env,
  })
  if (result.status !== expectedStatus) {
    throw new Error(
      `harness ${args.join(" ")}: код ${result.status}, ожидался ${expectedStatus}\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result.stdout
}

/** Асинхронный запуск: нужен, когда в этом же процессе работает HTTP-stub. */
function runAsync(project, args, expectedStatus) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: project, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === expectedStatus) {
        resolve(stdout)
        return
      }
      reject(
        new Error(
          `harness ${args.join(" ")}: код ${code}, ожидался ${expectedStatus}\n${stdout}\n${stderr}`,
        ),
      )
    })
  })
}

try {
  const source = path.join(temp, "source")
  await write(path.join(source, "demo", "SKILL.md"), "---\nname: demo\ndescription: CI demo\n---\nDemo\n")
  await write(
    path.join(process.env.XDG_CONFIG_HOME, "harness", "sources.yaml"),
    `sources:\n  ci-local:\n    type: local\n    path: ${JSON.stringify(source)}\n`,
  )

  const project = path.join(temp, "project")
  await write(
    path.join(project, "harness.yaml"),
    `version: 1
skills:
  - source: ci-local
    name: demo
    mode: reference
mcp:
  ci-local-mcp:
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
    description: CI-ревью без правок
    mode: subagent
    permissions:
      - action: edit
        resource: "*"
        effect: deny
    body: |
      Проверь изменения.
instructions:
  blocks:
    ci: |
      Проверка: \`node --version\`.
config:
  model: test/model
`,
  )

  /* Первый план: всё создать, секретов нет */
  const firstPlan = JSON.parse(run(project, ["plan", "--json"], 0))
  if (firstPlan.blocked !== undefined) throw new Error(`план заблокирован: ${firstPlan.blocked}`)
  if (firstPlan.summary.create < 7) {
    throw new Error(`ожидалось ≥ 7 create, получено: ${JSON.stringify(firstPlan.summary)}`)
  }
  if (firstPlan.secrets.length !== 0) throw new Error("в смоук-манифесте не должно быть секретов")

  /* Apply и строгий doctor */
  run(project, ["apply"], 0)
  run(project, ["doctor", "--strict"], 0)

  /* Идемпотентность */
  const secondPlan = JSON.parse(run(project, ["plan", "--json"], 0))
  const changed = secondPlan.summary.create + secondPlan.summary.update + secondPlan.summary.remove
  if (changed !== 0) throw new Error(`повторный план не пуст: ${JSON.stringify(secondPlan.summary)}`)
  if (secondPlan.drift.length !== 0) throw new Error(`drift после apply: ${secondPlan.drift.join("; ")}`)

  /* diff --json: расхождений нет */
  const emptyDiff = JSON.parse(run(project, ["diff", "--json"], 0))
  if (emptyDiff.entries.length !== 0) {
    throw new Error(`diff после apply не пуст: ${JSON.stringify(emptyDiff.entries.map((entry) => entry.target))}`)
  }

  /* doctor --fix: удалённый агент восстанавливается, strict снова зелёный */
  const agentPath = path.join(project, ".opencode", "agents", "reviewer.md")
  await fs.rm(agentPath)
  run(project, ["doctor", "--strict"], 1)
  const fixed = JSON.parse(run(project, ["doctor", "--fix", "--json"], 0))
  if (fixed.autoFix.skipped.length !== 0) {
    throw new Error(`doctor --fix отказался чинить: ${fixed.autoFix.skipped.join("; ")}`)
  }
  if (!fixed.autoFix.fixed.some((item) => item.target === "agent:reviewer")) {
    throw new Error("doctor --fix не восстановил агента")
  }
  if (!existsSync(agentPath)) throw new Error("файл агента не восстановлен")
  run(project, ["doctor", "--strict"], 0)

  /* diff и откат: правка конфига видна, --undo возвращает прежнее значение */
  const manifestPath = path.join(project, "harness.yaml")
  const manifestText = await fs.readFile(manifestPath, "utf8")
  await fs.writeFile(manifestPath, manifestText.replace("test/model", "test/model2"), "utf8")

  const changedDiff = JSON.parse(run(project, ["diff", "--json"], 0))
  const configDiff = changedDiff.entries.find((entry) => entry.target === "config:model")
  if (configDiff === undefined) throw new Error("diff не увидел изменение config:model")
  if (!configDiff.lines.some((line) => line.type === "add" && line.text.includes("test/model2"))) {
    throw new Error("diff не содержит нового значения config:model")
  }

  run(project, ["apply"], 0)
  const configFile = path.join(project, ".opencode", "opencode.jsonc")
  const configAfterChange = JSON.parse(await fs.readFile(configFile, "utf8"))
  if (configAfterChange.model !== "test/model2") throw new Error("изменение модели не применено")

  run(project, ["apply", "--undo"], 0)
  const restoredConfig = JSON.parse(await fs.readFile(configFile, "utf8"))
  if (restoredConfig.model !== "test/model") throw new Error("apply --undo не вернул конфиг")
  await fs.writeFile(manifestPath, manifestText, "utf8")
  run(project, ["apply"], 0)

  /* update --json: зеркала локальные, обновлять нечего */
  const updateReport = JSON.parse(run(project, ["update", "--json", "--dry-run"], 0))
  if (updateReport.dryRun !== true) throw new Error("update --json не отметил dry-run")
  if (updateReport.applied.length !== 0) throw new Error("update --json применил пункты в dry-run")
  if (updateReport.plan.drift.length !== 0) throw new Error("update --json видит drift")

  /* Артефакты */
  const linkPath = path.join(project, ".opencode", "skills", "demo")
  const linkStat = await fs.lstat(linkPath)
  if (!linkStat.isSymbolicLink()) throw new Error("reference-скилл не является ссылкой")

  const config = JSON.parse(await fs.readFile(path.join(project, ".opencode", "opencode.jsonc"), "utf8"))
  if (!Array.isArray(config.permissions) || config.permissions.length !== 1) {
    throw new Error("permissions не записаны в конфиг")
  }
  if (!Array.isArray(config.policies) || config.policies.length !== 1) {
    throw new Error("policies не записаны в конфиг")
  }

  const reviewer = await fs.readFile(path.join(project, ".opencode", "agents", "reviewer.md"), "utf8")
  if (!reviewer.startsWith("---\ndescription: CI-ревью без правок")) {
    throw new Error("markdown-агент не создан или frontmatter неверен")
  }

  const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8")
  if (!agents.includes("<!-- harness:begin:ci -->")) throw new Error("блок AGENTS.md не создан")

  /* MCP-каталог: локальный stub реестра — без сети и без реальных установок */
  const registryEntry = {
    server: {
      name: "io.example/ci-demo",
      description: "CI demo MCP",
      version: "1.2.3",
      packages: [
        {
          registryType: "npm",
          identifier: "ci-demo",
          version: "1.2.3",
          runtimeArguments: [{ type: "positional", value: "-y" }],
          environmentVariables: [{ name: "CI_TOKEN", isRequired: true, isSecret: true }],
        },
      ],
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  }
  const registryStub = createServer((request, response) => {
    const url = request.url ?? ""
    if (url.startsWith("/v0.1/servers/") && url.includes("/versions/latest")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(registryEntry))
      return
    }
    if (url.startsWith("/v0.1/servers?")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ servers: [registryEntry], metadata: { nextCursor: null } }))
      return
    }
    response.writeHead(404, { "content-type": "application/json" })
    response.end("{}")
  })
  await new Promise((resolve) => registryStub.listen(0, "127.0.0.1", resolve))
  const registryAddress = registryStub.address()
  if (registryAddress === null || typeof registryAddress === "string") {
    throw new Error("не удалось поднять stub MCP Registry")
  }
  process.env.HARNESS_REGISTRY_URL = `http://127.0.0.1:${registryAddress.port}`
  try {
    const registryProject = path.join(temp, "registry-project")
    await write(path.join(registryProject, "harness.yaml"), "version: 1\nmcp: {}\n")

    const found = JSON.parse(
      await runAsync(registryProject, ["mcp", "search", "ci-demo", "--json", "--refresh"], 0),
    )
    if (found.servers.length !== 1 || found.servers[0].name !== "io.example/ci-demo") {
      throw new Error(`mcp search вернул не то: ${JSON.stringify(found.servers)}`)
    }

    await runAsync(
      registryProject,
      ["mcp", "add", "io.example/ci-demo", "--name", "ci-demo", "--package", "npm", "--refresh"],
      0,
    )
    const registryManifest = await fs.readFile(path.join(registryProject, "harness.yaml"), "utf8")
    if (!registryManifest.includes("{env:CI_TOKEN}")) {
      throw new Error("mcp add не превратил секрет в {env:CI_TOKEN}")
    }
    if (registryManifest.includes("super-secret")) throw new Error("секрет попал в манифест")

    const registryPlan = JSON.parse(await runAsync(registryProject, ["plan", "--json"], 0))
    if (!registryPlan.items.some((item) => item.target === "mcp:ci-demo" && item.action === "create")) {
      throw new Error("plan не увидел MCP из реестра")
    }
    await runAsync(registryProject, ["apply"], 0)

    const registryConfig = JSON.parse(
      await fs.readFile(path.join(registryProject, ".opencode", "opencode.jsonc"), "utf8"),
    )
    const registryServer = registryConfig.mcp?.servers?.["ci-demo"]
    if (registryServer?.command?.[0] !== "npx" || registryServer?.command?.at(-1) !== "ci-demo@1.2.3") {
      throw new Error(`команда MCP из реестра неверна: ${JSON.stringify(registryServer)}`)
    }
    if (registryServer?.environment?.CI_TOKEN !== "{env:CI_TOKEN}") {
      throw new Error("MCP env не ссылается на переменную окружения")
    }
  } finally {
    delete process.env.HARNESS_REGISTRY_URL
    await new Promise((resolve) => registryStub.close(resolve))
  }

  /* Codex export: project-scope, без CODEX_HOME и без записи в реальный ~ */
  const codexResult = JSON.parse(run(project, ["codex", "export", "--json"], 0))
  const codexReport = codexResult.results[0]
  if (codexReport.errors.length > 0) {
    throw new Error(`codex export: ${codexReport.errors.join("; ")}`)
  }
  const codexConfig = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8")
  if (!codexConfig.includes("[mcp_servers.ci-local-mcp]")) {
    throw new Error("codex export не перенёс MCP")
  }
  if (!existsSync(path.join(project, ".codex", "agents", "reviewer.toml"))) {
    throw new Error("codex export не перенёс агента")
  }
  if (!existsSync(path.join(project, ".agents", "skills", "demo", "SKILL.md"))) {
    throw new Error("codex export не перенёс скилл")
  }
  /* permissions/policies/config не переносятся — strict обязан упасть */
  run(project, ["codex", "export", "--strict", "--json"], 1)
  run(project, ["codex", "undo"], 0)
  if (existsSync(path.join(project, ".codex", "config.toml"))) {
    throw new Error("codex undo не удалил сгенерированный config")
  }

  /* Глобальный скоуп: init → apply → doctor в изолированном XDG */
  const globalProject = path.join(temp, "global-project")
  await fs.mkdir(globalProject, { recursive: true })
  run(globalProject, ["--global", "init"], 0)
  await fs.writeFile(
    path.join(process.env.XDG_CONFIG_HOME, "harness", "harness.yaml"),
    "version: 1\nconfig:\n  model: global/model\n",
    "utf8",
  )
  run(globalProject, ["--global", "apply"], 0)
  run(globalProject, ["--global", "doctor", "--strict"], 0)
  const globalConfig = JSON.parse(
    await fs.readFile(path.join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), "utf8"),
  )
  if (globalConfig.model !== "global/model") throw new Error("глобальный конфиг не применён")
  if (existsSync(path.join(globalProject, ".opencode"))) {
    throw new Error("глобальный apply затронул проектный каталог")
  }

  console.log("✔ CI smoke пройден")
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
