import { describe, expect, it } from "vitest"
import { parseFrontmatter, scanMirror } from "../src/catalog/scan.js"
import { tempDir, writeFixture } from "./helpers.js"

describe("parseFrontmatter", () => {
  it("читает name и description", () => {
    const parsed = parseFrontmatter("---\nname: demo\ndescription: Тестовый скилл\n---\n# Тело\n")
    expect(parsed.name).toBe("demo")
    expect(parsed.description).toBe("Тестовый скилл")
  })

  it("читает frontmatter с CRLF (git core.autocrlf на Windows)", () => {
    const parsed = parseFrontmatter("---\r\nname: demo\r\ndescription: v1\r\n---\r\n# Тело\r\n")
    expect(parsed.name).toBe("demo")
    expect(parsed.description).toBe("v1")
  })

  it("битый frontmatter не роняет парсер", () => {
    expect(parseFrontmatter("---\nname: [не, closed\n---\n")).toEqual({ name: undefined, description: undefined })
  })

  it("возвращает undefined без frontmatter", () => {
    expect(parseFrontmatter("# Просто markdown\n")).toEqual({ name: undefined, description: undefined })
  })
})

describe("scanMirror", () => {
  it("находит скиллы на разной глубине и пропускает скрытые/игнорируемые", async () => {
    const root = await tempDir("harness-scan-")
    await writeFixture(root, "README.md", "# зеркало\n")
    await writeFixture(root, "android/navigation-3/SKILL.md", "---\nname: navigation-3\ndescription: Навигация\n---\n")
    await writeFixture(root, "android/.hidden/SKILL.md", "---\nname: hidden\n---\n")
    await writeFixture(root, "deep/a/b/tool/SKILL.md", "---\nname: deep-tool\n---\n")
    await writeFixture(root, "node_modules/fake/SKILL.md", "---\nname: fake\n---\n")
    await writeFixture(root, "plain-skill/SKILL.md", "нет frontmatter\n")

    const skills = await scanMirror(root, "test-src", "ref-123")
    const names = skills.map((skill) => skill.name).toSorted()
    expect(names).toEqual(["deep-tool", "navigation-3", "plain-skill"])

    const navigation = skills.find((skill) => skill.name === "navigation-3")
    expect(navigation?.source).toBe("test-src")
    expect(navigation?.ref).toBe("ref-123")
    expect(navigation?.relDir).toBe("android/navigation-3")
  })
})
