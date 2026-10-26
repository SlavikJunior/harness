# harness

CLI для декларативной настройки OpenCode-харнесса под проект по манифесту `harness.yaml`.

Идея: состояние OpenCode-харнесса проекта (скиллы, MCP-серверы, ключевые поля конфига)
описывается одним YAML-файлом, а инструмент приводит проект к этому состоянию
идемпотентно: `plan` показывает diff, `apply` применяет, `doctor` проверяет.

## Workflow

```bash
harness init              # черновик harness.yaml по детекции стека проекта
harness skills list       # каталог скиллов из всех источников
harness add skill android-skills/navigation-3        # добавить скилл в манифест
harness add mcp playwright --local bunx @playwright/mcp
harness plan              # предпросмотр изменений (dry-run)
harness apply             # применить (идемпотентно)
harness doctor            # проверки состояния (опционально --live)
```

## Что чем управляет

| Артефакт | Механика |
|---|---|
| `.opencode/opencode.jsonc` | Файл **владеет** только harness. Правки — точечные (jsonc-parser), комментарии сохраняются. Пользовательский `opencode.json` никогда не изменяется |
| Скиллы `vendor` | Копия в `.opencode/skills/<name>/` — OpenCode находит их автоматически, в конфиг не пишется |
| Скиллы `reference` | Symlink в `.opencode/skills/<name>` → зеркало источника. Тоже без записи в конфиг |
| MCP-серверы | `.opencode/opencode.jsonc` → `mcp.servers.<name>`. OpenCode deep-merge'ит по серверам — чужие серверы не затираются |
| `config.*` | Passthrough: значения пишутся как top-level ключи управляемого конфига |

Массив `skills` в конфиге OpenCode **не используется сознательно**: в V2 массивы
заменяются целиком (в отличие от объектов), поэтому запись в него затёрла бы
глобальные скиллы пользователя.

## Источники скиллов

Дефолтные: `android-skills` (github.com/android/skills), `alexgladkov`
(github.com/AlexGladkov/skills). Свои — в `~/.config/harness/sources.yaml`:

```yaml
sources:
  my-source:
    type: repo
    url: https://github.com/me/my-skills.git
  local-pack:
    type: local
    path: ~/dev/my-skills
```

repo-источники клонируются (shallow) в `~/.local/share/harness/mirrors/<id>`.
Перед клоном ищется существующий клон с тем же remote (например ручной clone в
`~/.config/opencode/skills/*`) и переиспользуется.

## State

`.harness/state.json` (добавляется в `.gitignore`) хранит хеши применённого:
конфиг-ключей, MCP-серверов, содержимого vendor-скиллов. На этом строятся
идемпотентность apply и детекция drift-а (файл правили вне harness).

## Разработка

```bash
npm install
npm run dev -- plan     # запуск без сборки
npm test                # vitest (без сети: local-источники + изолированные XDG)
npm run typecheck
npm run build           # tsc → dist/
```

## Ограничения MVP

- Только project-scope (глобальный конфиг не управляется)
- `permissions`/`instructions` — вне MVP (манифест расширяем)
- Symlink в reference-режиме: POSIX; на Windows требуется dev-режим
- Секреты: используй `{env:VAR}` в значениях MCP; аудит плейнтекст-секретов — в backlog
