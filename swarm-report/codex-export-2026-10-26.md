# Codex export: OpenCode → Codex

Дата: 2026-10-26 · Статус: реализовано (`harness codex export|undo`)

## Что сделано

Односторонний перенос OpenCode-харнесса в Codex. Источник правды —
`harness.yaml` + фактические артефакты OpenCode; Codex-файлы генерируются,
OpenCode не меняется.

```bash
harness codex export [--global|--all] [--dry-run] [--json] [--strict]
                     [--force] [--manifest-only]
harness codex undo [--global|--all] [--dry-run] [--json]
```

Переносится:

| OpenCode | Codex |
|---|---|
| `AGENTS.md` (managed-блоки) | `AGENTS.md` / `$CODEX_HOME/AGENTS.md` |
| скиллы vendor/reference | `.agents/skills/<name>` / `~/.agents/skills/<name>` |
| MCP local/remote | `[mcp_servers.<name>]` в `.codex/config.toml` / `$CODEX_HOME/config.toml` |
| markdown-агенты | `.codex/agents/<name>.toml` / `$CODEX_HOME/agents/` |

Не переносится автоматически и попадает в отчёт: `permissions`/`policies`,
`config.*` (model, provider, theme, keybinds, formatter, LSP, plugins),
OpenCode-модели агентов и agent-level permissions.

## Ключевые решения

- **Project и global** — оба скоупа; global правит только
  `[mcp_servers.*]` в `$CODEX_HOME/config.toml`, не перезаписывая чужие ключи
  и комментарии (TOML AST через `toml-eslint-parser`).
- **Пути Codex**: config/instructions/agents — `$CODEX_HOME` (default
  `~/.codex`); пользовательские скиллы — `$HOME/.agents/skills` (отдельно от
  `CODEX_HOME`, как в официальной документации).
- **Односторонне**: Codex-файлы генерируются; ручные правки ловятся по hash
  из `codex-state.json` и не перезаписываются без `--force`.
- **Live-only артефакты** фактического `.opencode` добавляются по умолчанию
  с пометкой `approximate`; `--manifest-only` оставляет только манифест.
- **Секреты**: `{env:VAR}` → `env_vars` / `env_http_headers` /
  `bearer_token_env_var`; `{file:...}`, смешанные подстановки, литеральные
  токены, URL с credentials — `skipped`, без записи значения.
- **Снапшоты**: перед записью — `backups-codex/` (последние 5), `codex undo`
  расходует снапшот; state и бэкапы — в `.harness/` или `~/.config/harness/`.
- **Отчёт**: `mapped`, `approximate`, `skipped`, `conflict`, `forced`,
  `unchanged`; `--strict` → exit 1 при approximate/skipped/conflict.
- **Безопасные конфликты**: чужой/изменённый файл → `conflict`, запись только
  с `--force` (с предварительным backup).

## Ограничения

- Codex загружает project `.codex/config.toml` только для trusted-проекта;
  trust не меняется автоматически (предупреждение в отчёте).
- `AGENTS.override.md` перекрывает `AGENTS.md`; лимит инструкций Codex —
  32 KiB (предупреждения).
- Полная копия глобальных инструкций делается только если целевого
  `$CODEX_HOME/AGENTS.md` ещё нет; дальше управляются только блоки.
- Inline-структура `mcp_servers = { ... }` не редактируется: честная ошибка.
- Обратного импорта правок Codex в OpenCode нет; это осознанно.
- `mode: primary`, `permissions` агента и OpenCode-модели не имеют прямого
  аналога в Codex — только отчёт.

## Проверки

- `tests/codex-mcp.test.ts` — маппинг MCP и секреты.
- `tests/codex-toml.test.ts` — TOML AST: сохранение чужих ключей/комментариев,
  удаление вложенных таблиц, inline-ошибка.
- `tests/codex-export.test.ts` — project: идемпотентность, конфликты,
  `--force`, dry-run, undo, live-only, managed-блоки.
- `tests/codex-global.test.ts` — global: точечный `config.toml`, инструкции,
  чужие MCP/скиллы, state/бэкапы в `~/.config/harness`.
- `scripts/ci-smoke.mjs` — e2e `codex export`, strict и undo на project.
- Полный прогон: `tsc --noEmit`, `vitest` (23 файла, 183 теста),
  `npm run build`, `npm run smoke`.
