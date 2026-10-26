import { describe, expect, it } from "vitest"
import { tempDir, writeFixture } from "./helpers.js"
import {
  changedUpstreams,
  parseLsRemote,
  resolveUpstreamRefs,
  upstreamKey,
  type RunFn,
} from "../src/catalog/upstream.js"
import type { SourceDef } from "../src/catalog/types.js"

/** Опрос upstream для update --watch: ls-remote, пины, local и сравнение. */

describe("parseLsRemote", () => {
  it("берёт SHA из HEAD-строки", () => {
    expect(parseLsRemote("abc123\tHEAD\n")).toBe("abc123")
  })

  it("для аннотированного тега предпочитает peeled ^{}", () => {
    const output = "1111111111111111111111111111111111111111\trefs/tags/v1\n" +
      "2222222222222222222222222222222222222222\trefs/tags/v1^{}\n"
    expect(parseLsRemote(output)).toBe("2222222222222222222222222222222222222222")
  })

  it("пустой вывод — undefined", () => {
    expect(parseLsRemote("\n")).toBeUndefined()
  })
})

describe("resolveUpstreamRefs", () => {
  it("опрашивает только repo-refs, пины не требуют сети, local — хеш", async () => {
    const calls: string[] = []
    const fakeRun: RunFn = async (_command, args) => {
      calls.push(args.join(" "))
      if (args.includes("v1")) {
        return {
          code: 0,
          stdout:
            "1111111111111111111111111111111111111111\trefs/tags/v1\n" +
            "2222222222222222222222222222222222222222\trefs/tags/v1^{}\n",
          stderr: "",
        }
      }
      return { code: 0, stdout: "3333333333333333333333333333333333333333\tHEAD\n", stderr: "" }
    }
    const local = await tempDir("harness-upstream-local-")
    await writeFixture(local, "demo/SKILL.md", "---\nname: demo\n---\n")
    const sources: Record<string, SourceDef> = {
      repo: { type: "repo", url: "https://example.com/skills.git" },
      local: { type: "local", path: local },
    }
    const pinned = "4444444444444444444444444444444444444444"
    const { resolved, errors } = await resolveUpstreamRefs(
      sources,
      {
        repo: [undefined, "v1", pinned],
        local: [undefined],
      },
      { run: fakeRun },
    )
    expect(errors).toEqual({})
    expect(resolved[upstreamKey("repo", undefined)]).toBe("3333333333333333333333333333333333333333")
    expect(resolved[upstreamKey("repo", "v1")]).toBe("2222222222222222222222222222222222222222")
    expect(resolved[upstreamKey("repo", pinned)]).toBe(pinned)
    expect(resolved[upstreamKey("local", undefined)]).toMatch(/^[0-9a-f]{64}$/)
    /* HEAD + тег (2 вызова), пин и local — без сети */
    expect(calls).toHaveLength(2)
  })

  it("ошибка одного источника не мешает остальным", async () => {
    const fakeRun: RunFn = async (_command, args) => {
      if (args.includes("missing")) return { code: 128, stdout: "", stderr: "not found" }
      return { code: 0, stdout: "5555555555555555555555555555555555555555\tHEAD\n", stderr: "" }
    }
    const sources: Record<string, SourceDef> = {
      good: { type: "repo", url: "https://example.com/good.git" },
      bad: { type: "repo", url: "https://example.com/bad.git" },
    }
    const { resolved, errors } = await resolveUpstreamRefs(
      sources,
      { good: [undefined], bad: ["missing"], unknown: [undefined] },
      { run: fakeRun },
    )
    expect(resolved[upstreamKey("good", undefined)]).toBeDefined()
    expect(errors[upstreamKey("bad", "missing")]).toContain("not found")
    expect(errors[upstreamKey("unknown", undefined)]).toContain("не найден")
  })
})

describe("changedUpstreams", () => {
  it("видит изменения, новые и исчезнувшие ключи", () => {
    expect(
      changedUpstreams(
        { "a@HEAD": "1", "b@HEAD": "2" },
        { "a@HEAD": "1", "b@HEAD": "3", "c@HEAD": "4" },
      ),
    ).toEqual(["b@HEAD", "c@HEAD"])
    expect(changedUpstreams({}, {})).toEqual([])
  })
})
