#!/usr/bin/env node
/**
 * Кросс-платформенный CI-смоук: init-манифест вручную → plan --json → apply →
 * doctor --strict → повторный plan. Проверяет ссылку reference-скилла
 * (на Windows — junction), permissions и управляемый блок AGENTS.md.
 */
import { promises as fs } from "node:fs"
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
  if (firstPlan.summary.create < 5) {
    throw new Error(`ожидалось ≥ 5 create, получено: ${JSON.stringify(firstPlan.summary)}`)
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

  /* Артефакты */
  const linkPath = path.join(project, ".opencode", "skills", "demo")
  const linkStat = await fs.lstat(linkPath)
  if (!linkStat.isSymbolicLink()) throw new Error("reference-скилл не является ссылкой")

  const config = JSON.parse(await fs.readFile(path.join(project, ".opencode", "opencode.jsonc"), "utf8"))
  if (!Array.isArray(config.permissions) || config.permissions.length !== 1) {
    throw new Error("permissions не записаны в конфиг")
  }

  const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8")
  if (!agents.includes("<!-- harness:begin:ci -->")) throw new Error("блок AGENTS.md не создан")

  console.log("✔ CI smoke пройден")
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
