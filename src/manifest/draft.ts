import type { DetectResult } from "../detect/index.js"

/** Черновик манифеста по результатам детекции. Строки идут в harness.yaml напрямую. */

export function draftManifest(detection: DetectResult): string {
  const stacks = detection.stacks.length
    ? detection.stacks.map((stack) => `${stack.title} (${stack.markers.join(", ")})`)
    : ["не определён — заполните секции вручную"]

  return `# harness.yaml — декларативная настройка OpenCode-харнесса этого проекта.
# Workflow: правишь манифест → harness plan (предпросмотр) → harness apply.
# Доступные скиллы: harness skills list. Источники: ~/.config/harness/sources.yaml.

# Заголовок версии. Сейчас только 1.
version: 1

# Скиллы: vendor — копия в .opencode/skills/ (пин в git проекта),
#         reference — symlink в общее зеркало (обновляется: harness apply --refresh).
# Пример:
#   skills:
#     - source: android-skills
#       name: navigation-3
#       mode: vendor
skills: []

# MCP-серверы. Пример:
#   mcp:
#     playwright:
#       type: local
#       command: [bunx, "@playwright/mcp"]
#     my-api:
#       type: remote
#       url: https://example.com/mcp
# Секреты — только через {env:VAR}: не пиши значения в файл.
mcp: {}

# Passthrough: значения пишутся как top-level поля .opencode/opencode.jsonc.
# Ключи skills, mcp, permissions, policies задавать здесь нельзя.
# Пример:
#   config:
#     model: anthropic/claude-sonnet-5-5
#     formatter: true
config: {}

# Детектированный стек: ${stacks.join("; ")}
`
}
