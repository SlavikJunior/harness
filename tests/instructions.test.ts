import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { tempDir, writeFixture } from "./helpers.js"
import { validateManifestText } from "../src/manifest/load.js"
import { buildDesiredState } from "../src/apply/desired.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { emptyState, loadState } from "../src/apply/state.js"
import { ManifestValidationError } from "../src/core/errors.js"
import {
  extractInstructionPaths,
  parseInstructionBlocks,
  renderInstructionBlocks,
} from "../src/apply/instructions.js"
import type { CatalogIndex } from "../src/catalog/types.js"

/**
 * Управляемые блоки инструкций: маркеры, сохранение пользовательского текста,
 * drift, удаление и перенос при смене файла.
 */

const EMPTY_CATALOG: CatalogIndex = { sources: {}, skills: [] }

async function setup(manifestText: string, agentsText?: string) {
  const project = await tempDir("harness-instr-")
  await writeFixture(project, "harness.yaml", manifestText)
  if (agentsText !== undefined) await writeFixture(project, "AGENTS.md", agentsText)
  const manifest = validateManifestText(manifestText)
  const desired = buildDesiredState(project, manifest, EMPTY_CATALOG)
  return { project, manifest, desired, state: emptyState() }
}

async function readFile(file: string): Promise<string> {
  return fs.readFile(file, "utf8")
}

describe("parseInstructionBlocks", () => {
  it("находит блоки и игнорирует пользовательский текст", () => {
    const parsed = parseInstructionBlocks(
      "# Заголовок\n\n<!-- harness:begin:build -->\nСборка: `./gradlew build`\n<!-- harness:end:build -->\n\nМои правила\n",
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.blocks.get("build")).toBe("Сборка: `./gradlew build`")
  })

  it("сообщает о незакрытом и повторном блоке", () => {
    const unclosed = parseInstructionBlocks("<!-- harness:begin:a -->\nтекст\n")
    expect(unclosed.errors.some((error) => error.includes("не закрыт"))).toBe(true)

    const duplicate = parseInstructionBlocks(
      "<!-- harness:begin:a -->\nx\n<!-- harness:end:a -->\n<!-- harness:begin:a -->\ny\n<!-- harness:end:a -->\n",
    )
    expect(duplicate.errors.some((error) => error.includes("повторно"))).toBe(true)
  })

  it("сообщает о чужом закрывающем маркере", () => {
    const parsed = parseInstructionBlocks("<!-- harness:begin:a -->\nx\n<!-- harness:end:b -->\n")
    expect(parsed.errors.length).toBeGreaterThan(0)
  })
})

describe("renderInstructionBlocks", () => {
  it("создаёт файл с маркерами", () => {
    const rendered = renderInstructionBlocks(undefined, [{ name: "build", content: "`./gradlew build`" }])
    expect(rendered.changed).toBe(true)
    expect(rendered.text).toBe("<!-- harness:begin:build -->\n`./gradlew build`\n<!-- harness:end:build -->\n")
  })

  it("идемпотентен", () => {
    const first = renderInstructionBlocks(undefined, [{ name: "build", content: "текст" }])
    const second = renderInstructionBlocks(first.text, [{ name: "build", content: "текст" }])
    expect(second.changed).toBe(false)
    expect(second.text).toBe(first.text)
  })

  it("сохраняет пользовательский текст и обновляет блок", () => {
    const original = "# Проект\n\nМои правила.\n\n<!-- harness:begin:build -->\nстарое\n<!-- harness:end:build -->\n"
    const rendered = renderInstructionBlocks(original, [{ name: "build", content: "новое" }], ["build"])
    expect(rendered.changed).toBe(true)
    expect(rendered.text).toContain("# Проект\n\nМои правила.")
    expect(rendered.text).toContain("новое")
    expect(rendered.text).not.toContain("старое")
  })

  it("удаляет блок и не оставляет двойных пустых строк", () => {
    const original = "До блока.\n\n<!-- harness:begin:old -->\nтекст\n<!-- harness:end:old -->\n\nПосле блока.\n"
    const rendered = renderInstructionBlocks(original, [], ["old"])
    expect(rendered.text).toBe("До блока.\n\nПосле блока.\n")
  })

  it("не трогает блоки, которыми не владеет", () => {
    const foreign = "<!-- harness:begin:foreign -->\nчужое\n<!-- harness:end:foreign -->\n"
    const rendered = renderInstructionBlocks(foreign, [], ["old"])
    expect(rendered.text).toBe(foreign)
  })
})

describe("extractInstructionPaths", () => {
  it("берёт команды и пути из inline-code, отбрасывая шаблоны", () => {
    const entries = extractInstructionPaths([
      {
        name: "build",
        content:
          "Сборка: `./gradlew assembleDebug`, версии: `gradle/libs.versions.toml`.\nURL: `https://example.com/x`, шаблон: `{env:HOME}/x`.",
      },
    ])
    expect(entries).toEqual(["./gradlew", "gradle/libs.versions.toml"])
  })
})

describe("схема манифеста", () => {
  it("запрещает путь за пределы проекта", async () => {
    await expect(
      setup("version: 1\ninstructions:\n  file: ../AGENTS.md\n  blocks:\n    a: текст\n"),
    ).rejects.toBeInstanceOf(ManifestValidationError)
  })

  it("запрещает абсолютный путь и маркеры в содержимом", async () => {
    await expect(
      setup("version: 1\ninstructions:\n  file: /tmp/AGENTS.md\n  blocks:\n    a: текст\n"),
    ).rejects.toBeInstanceOf(ManifestValidationError)
    await expect(
      setup('version: 1\ninstructions:\n  blocks:\n    a: "<!-- harness:begin:x -->"\n'),
    ).rejects.toBeInstanceOf(ManifestValidationError)
  })

  it("запрещает пустой блок", async () => {
    await expect(
      setup('version: 1\ninstructions:\n  blocks:\n    a: "   "\n'),
    ).rejects.toBeInstanceOf(ManifestValidationError)
  })
})

const MANIFEST_WITH_BLOCKS = `version: 1
instructions:
  blocks:
    build: |
      Сборка: \`./gradlew assembleDebug\`.
    versions: |
      Версии — только из \`gradle/libs.versions.toml\`.
`

describe("plan/apply инструкций", () => {
  it("создаёт блоки, сохраняя пользовательский текст, и идемпотентен", async () => {
    const { project, desired, state } = await setup(MANIFEST_WITH_BLOCKS, "# Проект\n\nМои правила.\n")
    const plan = await computePlan(project, desired, state)
    expect(plan.blocked).toBeUndefined()
    const creates = plan.items.filter((item) => item.kind === "instructions" && item.action === "create")
    expect(creates.map((item) => item.target).toSorted()).toEqual([
      "instructions:build",
      "instructions:versions",
    ])

    await applyDesired(project, desired, plan, state)
    const text = await readFile(path.join(project, "AGENTS.md"))
    expect(text).toContain("# Проект\n\nМои правила.")
    expect(text).toContain("<!-- harness:begin:build -->")
    expect(text).toContain("./gradlew assembleDebug")

    const nextState = await loadState(project)
    expect(Object.keys(nextState.instructions.blocks).toSorted()).toEqual(["build", "versions"])
    expect(nextState.instructions.file).toBe("AGENTS.md")

    const plan2 = await computePlan(project, desired, nextState)
    expect(plan2.items.filter((item) => item.action !== "unchanged")).toHaveLength(0)
  })

  it("видит drift при правке блока и перезаписывает его", async () => {
    const { project, desired, state } = await setup(MANIFEST_WITH_BLOCKS)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const file = path.join(project, "AGENTS.md")
    const edited = (await readFile(file)).replace("./gradlew assembleDebug", "./gradlew build")
    await fs.writeFile(file, edited, "utf8")

    const driftState = await loadState(project)
    const driftPlan = await computePlan(project, desired, driftState)
    expect(driftPlan.drift.some((entry) => entry.includes("instructions:build"))).toBe(true)

    const update = driftPlan.items.find((item) => item.target === "instructions:build")
    expect(update?.action).toBe("update")
    expect(update?.warn).toContain("вне harness")

    await applyDesired(project, desired, driftPlan, driftState)
    expect(await readFile(file)).toContain("./gradlew assembleDebug")
  })

  it("восстанавливает удалённый блок", async () => {
    const { project, desired, state } = await setup(MANIFEST_WITH_BLOCKS)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const file = path.join(project, "AGENTS.md")
    await fs.writeFile(file, "# Только пользовательский текст\n", "utf8")

    const deletedState = await loadState(project)
    const plan = await computePlan(project, desired, deletedState)
    expect(plan.drift.some((entry) => entry.includes("удалён"))).toBe(true)
    expect(plan.items.filter((item) => item.action === "create")).toHaveLength(2)

    await applyDesired(project, desired, plan, deletedState)
    const text = await readFile(file)
    expect(text).toContain("# Только пользовательский текст")
    expect(text).toContain("<!-- harness:begin:build -->")
    expect(text).toContain("<!-- harness:begin:versions -->")
  })

  it("удаляет блок, убранный из манифеста", async () => {
    const { project, desired, state } = await setup(MANIFEST_WITH_BLOCKS)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)

    const manifest2 = validateManifestText(`version: 1
instructions:
  blocks:
    build: |
      Сборка: \`./gradlew assembleDebug\`.
`)
    const desired2 = buildDesiredState(project, manifest2, EMPTY_CATALOG)
    const state2 = await loadState(project)
    const plan = await computePlan(project, desired2, state2)
    const removals = plan.items.filter((item) => item.action === "remove").map((item) => item.target)
    expect(removals).toEqual(["instructions:versions"])

    await applyDesired(project, desired2, plan, state2)
    const text = await readFile(path.join(project, "AGENTS.md"))
    expect(text).toContain("<!-- harness:begin:build -->")
    expect(text).not.toContain("versions")
    expect((await loadState(project)).instructions.blocks).not.toHaveProperty("versions")
  })

  it("поддерживает свой файл и переносит блоки при его смене", async () => {
    const { project, desired, state } = await setup(`version: 1
instructions:
  file: docs/AGENTS.md
  blocks:
    build: |
      Сборка: \`./gradlew build\`.
`)
    await applyDesired(project, desired, await computePlan(project, desired, state), state)
    const docsFile = path.join(project, "docs", "AGENTS.md")
    expect(await readFile(docsFile)).toContain("<!-- harness:begin:build -->")

    const manifest2 = validateManifestText(`version: 1
instructions:
  blocks:
    build: |
      Сборка: \`./gradlew build\`.
`)
    const desired2 = buildDesiredState(project, manifest2, EMPTY_CATALOG)
    const state2 = await loadState(project)
    const plan = await computePlan(project, desired2, state2)
    const removals = plan.items.filter((item) => item.action === "remove")
    expect(removals).toHaveLength(1)
    expect(removals[0]?.detail).toContain("docs/AGENTS.md")

    await applyDesired(project, desired2, plan, state2)
    expect(await readFile(docsFile)).not.toContain("harness:begin")
    expect(await readFile(path.join(project, "AGENTS.md"))).toContain("<!-- harness:begin:build -->")
    expect((await loadState(project)).instructions.file).toBe("AGENTS.md")
  })

  it("блокирует apply при повреждённых маркерах", async () => {
    const { project, desired, state } = await setup(MANIFEST_WITH_BLOCKS, "<!-- harness:begin:build -->\nбез конца\n")
    const plan = await computePlan(project, desired, state)
    expect(plan.blocked).toContain("маркеры")
    await expect(applyDesired(project, desired, plan, state)).rejects.toThrow()
  })
})
