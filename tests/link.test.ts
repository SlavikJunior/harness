import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  createReferenceLink,
  normalizeLinkTarget,
  referenceLinkType,
  sameLinkTarget,
  windowsLinkHint,
} from "../src/apply/link.js"
import { tempDir, writeFixture } from "./helpers.js"

/** Windows-ссылки: junction, нормализация путей и понятная ошибка без прав. */

describe("referenceLinkType", () => {
  it("на Windows — junction, на POSIX — symlink", () => {
    expect(referenceLinkType("win32")).toBe("junction")
    expect(referenceLinkType("darwin")).toBe("dir")
    expect(referenceLinkType("linux")).toBe("dir")
  })
})

describe("normalizeLinkTarget", () => {
  it("разворачивает относительный путь от директории ссылки", () => {
    expect(normalizeLinkTarget("demo", "/proj/.opencode/skills/demo", "linux")).toBe(
      "/proj/.opencode/skills/demo",
    )
    expect(normalizeLinkTarget("../shared/demo", "/proj/.opencode/skills/demo", "linux")).toBe(
      "/proj/.opencode/shared/demo",
    )
  })

  it("на POSIX сохраняет регистр и убирает хвостовой слэш", () => {
    expect(normalizeLinkTarget("/Mirror/Demo/", "/proj/skills/demo", "darwin")).toBe("/Mirror/Demo")
    expect(sameLinkTarget("/Mirror/Demo", "/proj/skills/demo", "/mirror/demo", "darwin")).toBe(false)
  })

  it("на Windows приводит слэши, регистр и NT-префикс", () => {
    const link = "C:\\proj\\.opencode\\skills\\demo"
    expect(normalizeLinkTarget("C:\\Users\\Dev\\Mirror\\Demo\\", link, "win32")).toBe(
      "c:/users/dev/mirror/demo",
    )
    expect(normalizeLinkTarget("\\\\?\\C:\\Users\\Dev\\Mirror\\Demo", link, "win32")).toBe(
      "c:/users/dev/mirror/demo",
    )
    expect(normalizeLinkTarget("C:/Users/Dev/Mirror/Demo", link, "win32")).toBe(
      "c:/users/dev/mirror/demo",
    )
  })

  it("sameLinkTarget на Windows не зависит от регистра и разделителей", () => {
    const link = "C:\\proj\\.opencode\\skills\\demo"
    const source = "c:/Users/Dev/Mirror/Demo"
    expect(sameLinkTarget("C:\\Users\\Dev\\Mirror\\Demo", link, source, "win32")).toBe(true)
    expect(sameLinkTarget("C:\\Users\\Dev\\Mirror\\Other", link, source, "win32")).toBe(false)
  })
})

describe("windowsLinkHint", () => {
  it("подсказывает про права только для известных кодов", () => {
    expect(windowsLinkHint("EPERM")).toContain("Developer Mode")
    expect(windowsLinkHint("EACCES")).toContain("mode: vendor")
    expect(windowsLinkHint("ENOENT")).toBeUndefined()
    expect(windowsLinkHint(undefined)).toBeUndefined()
  })
})

describe("createReferenceLink", () => {
  it("создаёт symlink на текущей платформе и видит его через lstat/readlink", async () => {
    const root = await tempDir("harness-link-")
    const source = path.join(root, "mirror", "demo")
    const target = path.join(root, ".opencode", "skills", "demo")
    await writeFixture(source, "SKILL.md", "---\nname: demo\n---\n")
    await fs.mkdir(path.dirname(target), { recursive: true })

    await createReferenceLink(source, target)
    const stats = await fs.lstat(target)
    expect(stats.isSymbolicLink()).toBe(true)
    expect(await fs.readlink(target)).toBe(source)
  })
})
