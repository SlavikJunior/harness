#!/usr/bin/env node
/**
 * Кросс-платформенный CI-смоук: init-манифест вручную → plan --json → apply →
 * doctor --strict → повторный plan. Проверяет ссылку reference-скилла
 * (на Windows — junction), permissions и управляемый блок AGENTS.md.
 */
import { existsSync, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
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
