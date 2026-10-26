import pc from "picocolors"
import type { CodexItem, CodexExportResult, CodexStatus } from "./types.js"
import { summarizeCodexItems } from "./types.js"
import type { CodexRestoreOutcome } from "./backup.js"

/** Человеческий вывод Codex export/undo; JSON-режим живёт в CLI. */

const SECTION_TITLES: Record<CodexItem["section"], string> = {
  skills: "Скиллы",
  instructions: "Инструкции",
  mcp: "MCP",
  agents: "Агенты",
  config: "Конфиг OpenCode (не переносится)",
}

function glyph(status: CodexStatus): string {
  switch (status) {
    case "mapped":
      return pc.green("✔")
    case "approximate":
      return pc.yellow("⚠")
    case "skipped":
      return pc.dim("·")
    case "conflict":
      return pc.red("✖")
    case "forced":
      return pc.yellow("↻")
    default:
      return pc.dim("·")
  }
}

export function printCodexResult(result: CodexExportResult): void {
  console.log("")
  console.log(
    pc.bold(`Codex export · ${result.scope}`) +
      pc.dim(` → ${result.codexHome}${result.dryRun ? " (dry-run)" : ""}`),
  )
  for (const section of Object.keys(SECTION_TITLES) as CodexItem["section"][]) {
    const items = result.items.filter((item) => item.section === section)
    if (items.length === 0) continue
    console.log(`  ${pc.bold(SECTION_TITLES[section])}`)
    for (const item of items) {
      const target = item.target === undefined ? "" : pc.dim(` → ${item.target}`)
      const message = item.message === undefined ? "" : pc.dim(` — ${item.message}`)
      console.log(`    ${glyph(item.status)} ${item.name}${target}${message}`)
    }
  }
  const summary = summarizeCodexItems(result.items)
  console.log("")
  console.log(
    `  mapped: ${summary.mapped} · approximate: ${summary.approximate} · skipped: ${summary.skipped} · conflicts: ${summary.conflict} · unchanged: ${summary.unchanged}`,
  )
  console.log(
    `  записано: ${result.written.length} · удалено: ${result.removed.length}${
      result.backupDir === undefined ? "" : ` · бэкап: ${result.backupDir}`
    }`,
  )
  for (const error of result.errors) console.log(`  ${pc.red("✖")} ${error}`)
}

export function printCodexResults(results: readonly CodexExportResult[]): void {
  for (const result of results) printCodexResult(result)
}

export function printCodexRestore(outcome: CodexRestoreOutcome): void {
  console.log("")
  console.log(pc.bold(outcome.dryRun ? "Codex undo (dry-run)" : "Codex undo"))
  console.log(pc.dim(`  снапшот: ${outcome.displayDir}`))
  for (const action of outcome.actions) {
    const icon = action.action === "restore" ? pc.green("↩") : pc.red("-")
    const verb = action.action === "restore" ? "восстановить" : "удалить"
    console.log(`  ${icon} ${action.display} ${pc.dim(`— ${verb}`)}`)
  }
  console.log("")
  console.log(
    `${pc.green("✔")} восстановлено: ${outcome.restored}, удалено: ${outcome.removed}` +
      (outcome.dryRun ? "" : " · снапшот израсходован"),
  )
}
