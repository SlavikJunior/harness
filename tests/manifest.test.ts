import { describe, expect, it } from "vitest"
import { validateManifestText } from "../src/manifest/load.js"
import { ManifestValidationError } from "../src/core/errors.js"

const VALID = `
version: 1
skills:
  - source: android-skills
    name: navigation-3
    mode: vendor
mcp:
  playwright:
    type: local
    command: [bunx, "@playwright/mcp"]
  api:
    type: remote
    url: https://example.com/mcp
config:
  model: anthropic/claude-sonnet-5-5
`

describe("validateManifestText", () => {
  it("валидирует корректный манифест", () => {
    const manifest = validateManifestText(VALID)
    expect(manifest.version).toBe(1)
    expect(manifest.skills).toHaveLength(1)
    expect(manifest.skills?.[0]?.name).toBe("navigation-3")
    expect(manifest.mcp?.playwright?.type).toBe("local")
    expect(manifest.mcp?.api?.type).toBe("remote")
    expect(manifest.config?.model).toBe("anthropic/claude-sonnet-5-5")
  })

  it("mode по умолчанию необязателен", () => {
    const manifest = validateManifestText("version: 1\n")
    expect(manifest.skills).toBeUndefined()
  })

  it("отвергает неверную версию", () => {
    expect(() => validateManifestText("version: 2\n")).toThrow(ManifestValidationError)
  })

  it("отвергает неизвестные поля (strict)", () => {
    expect(() => validateManifestText("version: 1\nskils: []\n")).toThrow(ManifestValidationError)
  })

  it("отвергает недопустимое имя mcp-сервера", () => {
    const text = "version: 1\nmcp:\n  плохое имя:\n    type: local\n    command: [x]\n"
    try {
      validateManifestText(text)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError)
      const issue = (error as ManifestValidationError).issues.find((i) => i.path.startsWith("mcp."))
      expect(issue).toBeDefined()
    }
  })

  it("находит дубликаты скиллов", () => {
    const text = `
version: 1
skills:
  - source: a
    name: x
  - source: a
    name: x
`
    try {
      validateManifestText(text)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError)
      const issues = (error as ManifestValidationError).issues
      expect(issues.some((issue) => issue.message.includes("дубликат"))).toBe(true)
    }
  })

  it("запрещает зарезервированные ключи config", () => {
    try {
      validateManifestText("version: 1\nconfig:\n  skills: []\n")
      expect.unreachable()
    } catch (error) {
      const issues = (error as ManifestValidationError).issues
      expect(issues.some((issue) => issue.message.includes("зарезервирован"))).toBe(true)
    }
  })

  it("позиционирует ошибку на строку", () => {
    const text = `
version: 1
skills:
  - source: a
    name: x
    mode: wrong-mode
`
    try {
      validateManifestText(text)
      expect.unreachable()
    } catch (error) {
      const issue = (error as ManifestValidationError).issues[0]
      expect(issue?.line).toBe(6)
    }
  })
})
