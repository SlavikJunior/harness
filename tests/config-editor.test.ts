import { describe, expect, it } from "vitest"
import { ConfigEditor, validateJsoncText } from "../src/apply/config.js"
import { deepEqual, stableStringify } from "../src/core/hash.js"

describe("ConfigEditor", () => {
  it("создаёт конфиг с нуля: $schema и вложенный mcp.servers", () => {
    const editor = ConfigEditor.from(undefined)
    editor.set(["$schema"], "https://opencode.ai/config.json")
    editor.set(["model"], "test/model")
    editor.set(["mcp", "servers", "tester"], { type: "local", command: ["echo", "hi"] })

    const text = editor.currentText
    expect(validateJsoncText(text)).toBeUndefined()
    const check = ConfigEditor.from(text)
    expect(check.valueAt(["model"])).toBe("test/model")
    expect(deepEqual(check.valueAt(["mcp", "servers", "tester"]), { type: "local", command: ["echo", "hi"] })).toBe(true)
  })

  it("сохраняет комментарии и чужие ключи при правке", () => {
    const original = `{\n  // пользовательский комментарий\n  "keepMe": true,\n  "old": 1\n}`
    const editor = ConfigEditor.from(original)
    editor.set(["added"], "x")
    editor.remove(["old"])
    const text = editor.currentText
    expect(text).toContain("пользовательский комментарий")
    expect(check(editor.currentText, "keepMe")).toBe(true)
    expect(check(editor.currentText, "added")).toBe(true)
    expect(check(editor.currentText, "old")).toBe(false)
  })

  it("set идемпотентен при том же значении", () => {
    const editor = ConfigEditor.from('{"a": 1}')
    expect(editor.set(["a"], 1)).toBe(false)
    expect(editor.set(["a"], 2)).toBe(true)
    expect(editor.set(["a"], 2)).toBe(false)
  })

  it("remove несуществующего ключа — false", () => {
    const editor = ConfigEditor.from('{"a": 1}')
    expect(editor.remove(["nope"])).toBe(false)
  })

  it("ломанный JSONC обнаруживается валидатором", () => {
    expect(validateJsoncText('{"a": 1,,}')).toBeDefined()
    expect(validateJsoncText('{"a": 1}')).toBeUndefined()
  })
})

function check(text: string, key: string): boolean {
  const editor = ConfigEditor.from(text)
  return editor.valueAt([key]) !== undefined
}

describe("stableStringify / deepEqual", () => {
  it("порядок ключей не влияет", () => {
    expect(stableStringify({ a: 1, b: [1, { c: 2 }] })).toBe(stableStringify({ b: [1, { c: 2 }], a: 1 }))
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
  })

  it("порядок массивов важен", () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
  })
})
