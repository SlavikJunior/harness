import path from "node:path"
import { promises as fs } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { runChecked } from "../src/core/exec.js"
import { HarnessError } from "../src/core/errors.js"
import { buildCatalog } from "../src/catalog/index.js"
import { pinnedMirrorDir } from "../src/catalog/mirror.js"
import { buildDesiredState, catalogRefs } from "../src/apply/desired.js"
import { validateManifestText } from "../src/manifest/load.js"
import { computePlan } from "../src/apply/plan.js"
import { applyDesired } from "../src/apply/apply.js"
import { emptyState, loadState } from "../src/apply/state.js"
import { tempDir, writeFixture, isolateXdg } from "./helpers.js"

/**
 * Пин скиллов по ref: отдельное зеркало на каждый ref, выбор нужной версии
 * при резолве, e2e-переключение v1 → v2 и запрет ref для local-источников.
 */

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

async function git(repo: string, args: string[]): Promise<void> {
  await runChecked("git", ["-C", repo, ...args])
}

async function commit(repo: string, message: string): Promise<void> {
  await git(repo, ["add", "-A"])
  await git(repo, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", message])
}

/** Локальный git-репозиторий с тегами v1/v2 — офлайн-замена GitHub. */
async function makeRemote(): Promise<string> {
  const repo = await tempDir("harness-remote-")
  await writeFixture(repo, "demo/SKILL.md", "---\nname: demo\ndescription: v1\n---\nверсия 1\n")
  await git(repo, ["init", "-q"])
  await commit(repo, "v1")
  await git(repo, ["tag", "v1"])
  await writeFixture(repo, "demo/SKILL.md", "---\nname: demo\ndescription: v2\n---\nверсия 2\n")
  await commit(repo, "v2")
  await git(repo, ["tag", "v2"])
  return repo
}

async function setupSources(remote: string): Promise<string> {
  const configHome = await tempDir("harness-cfg-")
  const dataHome = await tempDir("harness-data-")
  cleanup = isolateXdg(configHome, dataHome)
  await writeFixture(
    configHome,
    "harness/sources.yaml",
    `sources:\n  pins:\n    type: repo\n    url: file://${remote}\n`,
  )
  return tempDir("harness-pin-proj-")
}

describe("зеркала с пином", () => {
  it("каждый ref получает отдельную директорию зеркала", () => {
    expect(pinnedMirrorDir("src", "v1")).not.toBe(pinnedMirrorDir("src", "v2"))
    expect(pinnedMirrorDir("src", "v1")).toBe(pinnedMirrorDir("src", "v1"))
    expect(pinnedMirrorDir("src", "release/1.0")).toContain("release-1.0")
  })
})

describe("резолв скилла по ref", () => {
  it("берёт версию указанного тега, а без ref — HEAD", async () => {
    const remote = await makeRemote()
    const project = await setupSources(remote)

    const pinned = validateManifestText(
      "version: 1\nskills:\n  - source: pins\n    name: demo\n    ref: v1\n",
    )
    const v1Catalog = await buildCatalog({ refs: catalogRefs(pinned), sourceFilter: ["pins"] })
    const v1 = buildDesiredState(project, pinned, v1Catalog)
    expect(v1.skills[0]?.item.description).toBe("v1")

    const v2 = validateManifestText("version: 1\nskills:\n  - source: pins\n    name: demo\n    ref: v2\n")
    const v2Catalog = await buildCatalog({ refs: catalogRefs(v2), sourceFilter: ["pins"] })
    expect(buildDesiredState(project, v2, v2Catalog).skills[0]?.item.description).toBe("v2")

    const head = validateManifestText("version: 1\nskills:\n  - source: pins\n    name: demo\n")
    const headCatalog = await buildCatalog({ refs: catalogRefs(head), sourceFilter: ["pins"] })
    expect(buildDesiredState(project, head, headCatalog).skills[0]?.item.description).toBe("v2")
  })

  it("даёт понятную ошибку на несуществующий ref", async () => {
    const remote = await makeRemote()
    await setupSources(remote)
    const manifest = validateManifestText(
      "version: 1\nskills:\n  - source: pins\n    name: demo\n    ref: v9\n",
    )
    await expect(
      buildCatalog({ refs: catalogRefs(manifest), sourceFilter: ["pins"] }),
    ).rejects.toBeInstanceOf(HarnessError)
    await expect(
      buildCatalog({ refs: catalogRefs(manifest), sourceFilter: ["pins"] }),
    ).rejects.toThrow(/ref "v9"/)
  })

  it("запрещает ref для local-источника", async () => {
    const configHome = await tempDir("harness-cfg-")
    const dataHome = await tempDir("harness-data-")
    cleanup = isolateXdg(configHome, dataHome)
    const localDir = await tempDir("harness-local-")
    await writeFixture(localDir, "demo/SKILL.md", "---\nname: demo\n---\n")
    await writeFixture(configHome, "harness/sources.yaml", `sources:\n  local:\n    type: local\n    path: ${localDir}\n`)

    const manifest = validateManifestText(
      "version: 1\nskills:\n  - source: local\n    name: demo\n    ref: v1\n",
    )
    await expect(
      buildCatalog({ refs: catalogRefs(manifest), sourceFilter: ["local"] }),
    ).rejects.toThrow(/не поддерживает ref/)
  })

  it("применяет пин и переключает версию с планом update", async () => {
    const remote = await makeRemote()
    const project = await setupSources(remote)

    const manifestV1 = validateManifestText(
      "version: 1\nskills:\n  - source: pins\n    name: demo\n    ref: v1\n",
    )
    const catalogV1 = await buildCatalog({ refs: catalogRefs(manifestV1), sourceFilter: ["pins"] })
    const desiredV1 = buildDesiredState(project, manifestV1, catalogV1)
    const planV1 = await computePlan(project, desiredV1, emptyState())
    expect(planV1.items.find((item) => item.target === "skill:demo")?.detail).toContain("pins@v1")

    await applyDesired(project, desiredV1, planV1, emptyState())
    const skillFile = path.join(project, ".opencode", "skills", "demo", "SKILL.md")
    expect(await fs.readFile(skillFile, "utf8")).toContain("версия 1")

    const stateV1 = await loadState(project)
    expect(stateV1.skills.demo?.pin).toBe("v1")

    /* Переключение пина v1 → v2: план update, содержимое меняется */
    const manifestV2 = validateManifestText(
      "version: 1\nskills:\n  - source: pins\n    name: demo\n    ref: v2\n",
    )
    const catalogV2 = await buildCatalog({ refs: catalogRefs(manifestV2), sourceFilter: ["pins"] })
    const desiredV2 = buildDesiredState(project, manifestV2, catalogV2)
    const planV2 = await computePlan(project, desiredV2, stateV1)
    expect(planV2.items.find((item) => item.target === "skill:demo")?.action).toBe("update")

    await applyDesired(project, desiredV2, planV2, stateV1)
    expect(await fs.readFile(skillFile, "utf8")).toContain("версия 2")

    const stateV2 = await loadState(project)
    expect(stateV2.skills.demo?.pin).toBe("v2")
    expect(stateV2.skills.demo?.ref).not.toBe(stateV1.skills.demo?.ref)

    const planIdempotent = await computePlan(project, desiredV2, stateV2)
    expect(planIdempotent.items.filter((item) => item.action !== "unchanged")).toHaveLength(0)
  })
})
