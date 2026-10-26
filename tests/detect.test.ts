import { describe, expect, it } from "vitest"
import { detectStacks } from "../src/detect/index.js"
import { tempDir, writeFixture } from "./helpers.js"

describe("detectStacks", () => {
  it("определяет Android + Kotlin по gradle-файлам", async () => {
    const root = await tempDir("harness-detect-")
    await writeFixture(root, "settings.gradle.kts", "plugins { alias(libs.plugins.android.application) }\n")
    await writeFixture(root, "app/src/main/AndroidManifest.xml", "<manifest/>\n")

    const result = await detectStacks(root)
    const ids = result.stacks.map((stack) => stack.id)
    expect(ids).toContain("android")
    expect(ids).toContain("kotlin")
  })

  it("определяет node/typescript проект", async () => {
    const root = await tempDir("harness-detect-")
    await writeFixture(root, "package.json", '{ "name": "x", "devDependencies": { "next": "1" } }\n')
    await writeFixture(root, "tsconfig.json", "{}\n")

    const ids = (await detectStacks(root)).stacks.map((stack) => stack.id)
    expect(ids).toContain("node")
    expect(ids).toContain("typescript")
    expect(ids).toContain("node-next")
  })

  it("определяет go и rust", async () => {
    const root = await tempDir("harness-detect-")
    await writeFixture(root, "go.mod", "module x\n")
    await writeFixture(root, "Cargo.toml", "[package]\nname = \"x\"\n")
    const ids = (await detectStacks(root)).stacks.map((stack) => stack.id)
    expect(ids).toContain("go")
    expect(ids).toContain("rust")
  })

  it("пустой проект — пустой результат", async () => {
    const root = await tempDir("harness-detect-empty-")
    const result = await detectStacks(root)
    expect(result.stacks).toHaveLength(0)
  })
})
