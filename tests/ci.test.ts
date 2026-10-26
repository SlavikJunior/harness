import { describe, expect, it } from "vitest"
import { doctorExitCode, planExitCode, planReportJson, planSummary } from "../src/cli/json.js"
import type { PlanReport } from "../src/apply/types.js"
import type { DoctorCheck } from "../src/verify/doctor.js"

/** CI-контракт: JSON-отчёт плана и коды выхода doctor. */

function report(items: PlanReport["items"], extra: Partial<PlanReport> = {}): PlanReport {
  return { items, drift: [], conflicts: [], ...extra }
}

describe("planReportJson", () => {
  it("считает summary по действиям и сохраняет порядок items", () => {
    const view = planReportJson(
      report([
        { kind: "config", action: "create", target: "config:model" },
        { kind: "skill", action: "update", target: "skill:demo" },
        { kind: "skill", action: "unchanged", target: "skill:other" },
        { kind: "mcp", action: "remove", target: "mcp:old" },
        { kind: "skill", action: "unchanged", target: "skill:third" },
      ]),
    )
    expect(view.summary).toEqual({ create: 1, update: 1, remove: 1, unchanged: 2 })
    expect(view.items.map((item) => item.target)).toEqual([
      "config:model",
      "skill:demo",
      "skill:other",
      "mcp:old",
      "skill:third",
    ])
  })

  it("не включает blocked, если план не заблокирован, и выставляет его иначе", () => {
    expect(planReportJson(report([]))).not.toHaveProperty("blocked")
    expect(planReportJson(report([], { blocked: "плохой JSONC" })).blocked).toBe("плохой JSONC")
  })

  it("переносит секреты только как путь, вид и причину", () => {
    const view = planReportJson(report([]), [
      { path: "mcp.api.headers.Authorization", kind: "auth-header", reason: "заголовок авторизации" },
    ])
    expect(view.secrets).toEqual([
      { path: "mcp.api.headers.Authorization", kind: "auth-header", reason: "заголовок авторизации" },
    ])
  })

  it("план с drift и conflicts остаётся машиночитаемым", () => {
    const view = planReportJson(
      report([], { drift: ["skill:demo: правился вне harness"], conflicts: ["opencode.json перекрывает model"] }),
    )
    expect(view.drift).toHaveLength(1)
    expect(view.conflicts).toHaveLength(1)
    expect(planSummary(report([]))).toEqual({ create: 0, update: 0, remove: 0, unchanged: 0 })
  })
})

describe("коды выхода", () => {
  it("plan: 1 только при blocked", () => {
    expect(planExitCode(report([]))).toBe(0)
    expect(planExitCode(report([{ kind: "config", action: "update", target: "config:model" }]))).toBe(0)
    expect(planExitCode(report([], { blocked: "маркеры" }))).toBe(1)
  })

  it("doctor: ошибки — всегда 1, warn — только со strict", () => {
    const ok: DoctorCheck[] = [{ level: "ok", message: "всё хорошо" }]
    const warn: DoctorCheck[] = [{ level: "warn", message: "путь не найден" }]
    const error: DoctorCheck[] = [{ level: "error", message: "конфиг не парсится" }]

    expect(doctorExitCode(ok)).toBe(0)
    expect(doctorExitCode(warn)).toBe(0)
    expect(doctorExitCode(warn, { strict: true })).toBe(1)
    expect(doctorExitCode(error)).toBe(1)
    expect(doctorExitCode(error, { strict: true })).toBe(1)
  })
})
