# harness

CLI для декларативной настройки OpenCode-харнесса под проект по манифесту `harness.yaml`.

Идея: состояние OpenCode-харнесса проекта (скиллы, MCP-серверы, ключевые поля конфига)
описывается одним YAML-файлом, а инструмент приводит проект к этому состоянию
идемпотентно: `plan` показывает diff, `apply` применяет, `doctor` проверяет.

## Установка

```bash
git clone https://github.com/SlavikJunior/harness.git
cd harness
npm install
npm run build
npm link            # глобальная команда `harness`
```

Требуется Node.js ≥ 20. Без `npm link` — `node dist/cli/index.js <команда>`.

## Workflow

```bash
harness init              # черновик harness.yaml по детекции стека проекта
harness skills list       # каталог скиллов из всех источников
harness add skill android-skills/navigation-3        # добавить скилл в манифест
harness add mcp playwright --local bunx @playwright/mcp
harness mcp search filesystem                        # каталог MCP Registry
harness diff              # подробный diff: значения и файлы
harness plan              # предпросмотр изменений (dry-run)
harness apply             # применить (идемпотентно)
harness apply --undo      # откатить последний apply
harness update            # обновить зеркала источников и применить
harness update --watch    # следить за upstream и применять изменения
harness codex export      # перенести харнесс в Codex (односторонне)
harness doctor            # проверки состояния (опционально --live)
harness doctor --fix      # безопасные автоисправления
```

## Diff, снапшоты и откат

`harness plan` отвечает «что изменится», `harness diff` — «как именно»:

```bash
harness diff              # значения конфига/MCP, файлы скиллов, агенты, блоки
harness diff --json       # машиночитаемо (значения уже замаскированы)
```

- конфиг и MCP показываются как JSON-diff «текущее → манифест»;
- vendor-скиллы — файловый diff (`+` появится, `−` исчезнет, `~` изменится);
- агенты и блоки инструкций — построчный diff;
- секреты маскируются (`•••`) — diff можно прикладывать к issue и гонять в CI.

Перед каждой записью `apply` снимает снапшот только изменяемых артефактов
(конфиг, скиллы, агенты, инструкции, `.gitignore`, state) в
`.harness/backups/<время>/` (глобально — `~/.config/harness/backups/`).
Хранятся последние 5.

```bash
harness apply --undo --dry-run   # что будет восстановлено
harness apply --undo             # откатить последний apply
```

- откат — стек: после успешного `--undo` снапшот расходуется, следующий
  `--undo` вернёт ещё более раннее состояние;
- манифест не откатывается: после отката `harness plan` честно покажет
  расхождение между манифестом и артефактами;
- откат не читает манифест — работает, даже если YAML сломан.

## Автоисправление (`doctor --fix`)

`doctor --fix` применяет только безопасные расхождения: создаёт отсутствующие
артефакты (скилл, агент, блок, MCP, ключ конфига) и убирает то, чем harness
владеет по state. Всё, что похоже на ручную правку (`update` с предупреждением)
или на чужой ключ конфига, не трогается — для этого нужен осознанный
`harness apply`.
Если что-то осталось неисправленным, команда завершается с кодом 1.

```bash
harness doctor --fix           # исправить безопасное и показать проверки
harness doctor --fix --json    # { autoFix, checks }
```

## MCP-каталог

`harness mcp search|add` работают с официальным MCP Registry (API v0.1):

```bash
harness mcp search playwright --limit 10
harness mcp search filesystem --json --refresh
harness mcp add io.github.user/server --name my-server
harness mcp add io.github.user/server --package npm --version 1.2.3
harness mcp add io.github.user/server --remote --dry-run
```

- каталог **не устанавливает и не применяет** сервер сам: результат — запись
  в `harness.yaml`, дальше обычный `plan → apply`;
- по умолчанию выбирается remote, если он есть; иначе первый поддерживаемый
  пакет (`npm → pypi → oci → cargo`). `--remote`/`--package` задают явно;
- версия пакета фиксируется в команде (`pkg@1.2.3`, `pkg==1.2.3`, тег OCI);
  `mcpb`/`nuget` автоматически не поддерживаются — честная ошибка;
- секреты из реестра (`isSecret`, значения с токенами) превращаются в
  `{env:VAR}`; значения не печатаются и не пишутся. Требуемые переменные
  перечисляются в выводе;
- кэш — `$XDG_DATA_HOME/harness/registry`, TTL 24 часа, `--refresh` игнорирует;
  при недоступной сети используется stale-кэш с предупреждением;
- для тестов и внутренних зеркал endpoint переопределяется `HARNESS_REGISTRY_URL`;
- реестр не проверяет безопасность кода: перед `mcp add` смотри репозиторий
  и требования; `plan` покажет, что именно попадёт в конфиг.

## Watch-режим

```bash
harness update --watch --interval 300   # секунды, по умолчанию 300
```

- опрашивает upstream через `git ls-remote` (дёшево, без скачивания объектов);
- при изменении SHA делает обычный `update` (fetch/pull → plan → apply);
- `--json` печатает NDJSON: одна строка на цикл с изменениями;
- ошибка источника не останавливает цикл; Ctrl+C — корректная остановка;
- local-источники опрашиваются хешем директории; запиненные 40-символьные
  SHA неизменяемы и сеть для них не нужна.

## Codex export

`harness codex export` — односторонний перенос OpenCode-харнесса в Codex.
Источник правды остаётся `harness.yaml` + фактические артефакты OpenCode;
Codex-файлы только генерируются. OpenCode при этом не меняется.

```bash
harness codex export                    # project-scope
harness codex export --global           # ~/.codex и ~/.agents/skills
harness codex export --all              # project + global
harness codex export --dry-run          # только отчёт
harness codex export --json             # машиночитаемо
harness codex export --strict           # exit 1 при approximate/skipped/conflict
harness codex export --force            # перезаписать чужое/изменённое (с backup)
harness codex export --manifest-only    # не добавлять live-only артефакты OpenCode
harness codex undo [--global|--all]     # откатить последний export
```

| Что | Куда |
|---|---|
| MCP | `.codex/config.toml` (project) / `$CODEX_HOME/config.toml` (global) |
| Агенты | `.codex/agents/<name>.toml` / `$CODEX_HOME/agents/` |
| Скиллы | `.agents/skills/<name>` / `~/.agents/skills/<name>` |
| Инструкции проекта | общий `AGENTS.md` (managed-блоки) |
| Глобальные инструкции | `$CODEX_HOME/AGENTS.md` |
| State / бэкапы | `.harness/codex-state.json` / `~/.config/harness/` |

`CODEX_HOME` учитывается (по умолчанию `~/.codex`). Пользовательские скиллы
Codex всё равно живут в `~/.agents/skills` — это отдельный путь.

- скиллы: `vendor` копируется, `reference` становится symlink (на Windows —
  junction с fallback в копию);
- MCP: local `command[]` → `command` + `args`; `{env:VAR}` → `env_vars`;
  remote `Bearer {env:VAR}` → `bearer_token_env_var`, остальные env-заголовки →
  `env_http_headers`, статические → `http_headers`;
- агенты: `developer_instructions` из body; `mode`, `permissions` и
  OpenCode-модель не переносятся — это видно в отчёте;
- инструкции: managed-блоки с маркерами, пользовательский текст вне блоков
  сохраняется; если Codex-файла ещё нет, допускается полная копия;
- live-only скиллы/агенты/MCP из фактического `.opencode` добавляются по
  умолчанию (с пометкой `approximate`); `--manifest-only` отключает это.

**Не переносится автоматически:** `permissions`/`policies`, `config.*`
(модели, провайдеры, theme, keybinds, formatter, LSP, plugins), OpenCode
plugin-система. Эти пункты попадают в отчёт как `skipped`/`approximate`.

Владение и безопасность:
- без state harness не перезаписывает чужие `.codex`/`.agents` файлы:
  конфликт → `conflict` и пропуск, запись только с `--force`;
- перед записью снимается снапшот `backups-codex/` (последние 5); `codex undo`
  расходует снапшот;
- литеральные секреты, `{file:...}` и смешанные `{env:...}`-значения не
  копируются — сервер/агент/блок пропускается с предупреждением;
- Codex загружает project `.codex/config.toml` только для trusted-проекта;
  `AGENTS.override.md` перекрывает managed-блоки `AGENTS.md`; лимит инструкций
  Codex — 32 KiB (всё это попадает в предупреждения).

## CI

```bash
harness plan --json       # план в JSON: items, summary, drift, conflicts, blocked?, secrets
harness doctor --strict   # exit 1 при ошибках и при предупреждениях
```

- `plan --json` не печатает ANSI; детали уже замаскированы, `secrets` содержит
  только путь и причину — значения не выводятся никогда;
- заблокированный план (`blocked`) — exit 1 и в JSON, и в человеческом режиме;
- `doctor` возвращает 1 при ошибках всегда, `--strict` добавляет к этому warn
  (удобно как гейт в CI). `doctor --json` печатает тот же набор проверок.

```bash
harness plan --json > plan.json && harness doctor --strict
```

`harness update --json [--dry-run]` отдаёт `{ plan, applied, dryRun }`: план
обновления зеркал и фактически применённые пункты, без ANSI.

`harness diff --json` отдаёт `{ entries, blocked? }`, где `entries[]` —
`{ kind, target, action, detail?, lines[], note? }`. Значения уже
замаскированы, поэтому отчёт безопасно публиковать как артефакт CI.

`harness doctor --fix --json` отдаёт `{ autoFix: { fixed, skipped }, checks }`.
Если `skipped` непустой (ручные правки/чужие ключи), код выхода — 1.

`harness codex export --json` отдаёт `{ results: [{ scope, items, written, removed, backupDir?, errors }] }`.
Значения секретов в отчёт не попадают.

В `watch`-режиме `--json` печатает NDJSON: по одной строке на цикл с
изменениями (`{ at, firstCycle, changed, plan, applied, dryRun }`).

## Что чем управляет

| Артефакт | Механика |
|---|---|
| `.opencode/opencode.jsonc` | Файл **владеет** только harness. Правки — точечные (jsonc-parser), комментарии сохраняются. Пользовательский `opencode.json` никогда не изменяется |
| Скиллы `vendor` | Копия в `.opencode/skills/<name>/` — OpenCode находит их автоматически, в конфиг не пишется |
| Скиллы `reference` | Symlink в `.opencode/skills/<name>` → зеркало источника (Windows: junction). Тоже без записи в конфиг |
| MCP-серверы | `.opencode/opencode.jsonc` → `mcp.servers.<name>`. OpenCode deep-merge'ит по серверам — чужие серверы не затираются |
| `config.*` | Passthrough: значения пишутся как top-level ключи управляемого конфига |
| `permissions` | Top-level массив правил V2 `{ action, resource, effect }` — пишется как есть, порядок значим |
| `policies` | Top-level массив жёстких запретов V2 (`effect` только `deny`) |
| `agents` | Markdown `.opencode/agents/<name>.md`: frontmatter + body. Файл целиком наш, чужие агенты не трогаются |
| `AGENTS.md` | Только содержимое между маркерами `<!-- harness:begin:NAME -->`. Остальной текст файла — пользовательский и сохраняется |

Массив `skills` в конфиге OpenCode **не используется сознательно**: в V2 массивы
заменяются целиком (в отличие от объектов), поэтому запись в него затёрла бы
глобальные скиллы пользователя.

## Permissions (V2)

Правила V2 — массив `{ action, resource, effect }`, один в один с конфигом:

```yaml
permissions:
  - action: shell
    resource: "*"
    effect: ask
  - action: shell
    resource: "git status *"
    effect: allow
```

- порядок значим: побеждает **последнее** совпадение — harness пишет массив как
  есть и сравнивает упорядоченно (перестановка правил = update);
- V2 по умолчанию разрешает почти всё, а чтение `.env` требует подтверждения;
  поэтому правила обычно сужают (`ask`/`deny`). `doctor` предупредит, если
  `read allow` открывает `.env`, и про тотальный `*` / `*` deny;
- проектные правила идут раньше глобальных, глобальные добавляются после —
  значит глобальный `ask`/`deny` из проекта не перекрыть;
- нет секции — ключ `permissions` не управляется; убрал секцию после `apply` —
  записанные harness правила удаляются, чужие не трогаются.

## Policies (V2)

Политика — жёсткий `deny` поверх permissions и сохранённых approvals: она
никогда не разрешает, только запрещает. Поэтому `effect` в схеме — строго
`deny`, а `allow`/`ask` отклоняются ещё при валидации манифеста:

```yaml
policies:
  - action: shell
    resource: "sudo *"
    effect: deny
  - action: read
    resource: "secrets/*"
    effect: deny
```

- механика ownership и сравнения — как у `permissions`: массив пишется как
  есть, порядок значим, чужие политики без записи в state не удаляются;
- `doctor` предупредит о тотальном `*` / `*` deny и о `read "*"` deny —
  такие запреты делают агента бесполезным и не чинятся проектным `allow`;
- глобальные и Console-политики перекрывают проектные — из проекта их не
  отменить.

## Агенты

Агенты описываются markdown-файлами `.opencode/agents/<name>.md`:
frontmatter + body как system prompt.

```yaml
agents:
  reviewer:
    description: Ревью изменений без правок
    mode: subagent
    model: anthropic/claude-sonnet-5-5#high
    permissions:
      - action: edit
        resource: "*"
        effect: deny
    body: |
      Проверь текущие изменения и перечисли находки.
```

- поддерживаемые поля: `description`, `mode` (`primary|subagent|all`),
  `model`, `permissions`, `body`; остальное (`hidden`, `steps`, `color`,
  `request`) — вне MVP;
- файл целиком управляется harness: ручная правка видна как drift и
  перезаписывается при `apply`;
- агент, убранный из манифеста, удаляется только если был записан в state;
  чужие файлы с другими именами не трогаются;
- одноимённый файл вне harness будет перезаписан с предупреждением в плане.

## Глобальный скоуп

`--global` переключает команды на пользовательский харнесс (флаг можно ставить
до или после команды):

```bash
harness --global init
harness --global plan
harness --global apply
harness --global doctor
```

| Что | Где |
|---|---|
| Манифест | `~/.config/harness/harness.yaml` |
| State | `~/.config/harness/state.json` |
| Конфиг | `~/.config/opencode/opencode.json(c)` |
| Скиллы | `~/.config/opencode/skills/` |
| Агенты | `~/.config/opencode/agents/` |
| Инструкции | `~/.config/opencode/AGENTS.md` |

- глобальный конфиг — личный файл пользователя: harness правит только свои
  ключи (key-level ownership в state), остальное и комментарии сохраняются;
  если уже есть `opencode.json`, второй `.jsonc` не создаётся;
- глобальные `permissions`/`policies` перекрывают проектные: глобальный
  `ask`/`deny` из проекта не отменить — `doctor` об этом предупреждает;
- `.gitignore` и проверки конфликтов проектных конфигов к глобальному скоупу
  не применяются;
- `init --global` не детектит стек текущего каталога — черновик пустой;
- тот же флаг работает для новых команд: `harness --global diff`,
  `harness --global apply --undo`, `harness --global doctor --fix`,
  `harness --global update --watch`, `harness --global mcp add`,
  `harness --global codex export`, `harness --global codex undo`.

## Источники скиллов

Дефолтные: `android-skills` (github.com/android/skills), `alexgladkov`
(github.com/AlexGladkov/skills), `gradle-skills` (github.com/gradle/gradle-skills).
Свои — в `~/.config/harness/sources.yaml`:

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

## Pin версий скиллов

Скилл можно зафиксировать на тег/ветку/sha — источник «плавает» только тогда,
когда это нужно:

```yaml
skills:
  - source: android-skills
    name: navigation-3
    ref: v1.1.0        # тег, ветка или sha
    mode: vendor
```

- каждый ref живёт в отдельном зеркале `<id>@<ref>-<hash>`: проекты с разными
  пинами не перетирают друг друга;
- в state пишется и запрошенный `pin`, и фактический sha;
- `harness update` обновляет незапиненные скиллы до HEAD, а запиненные
  перечитывает по ref; изменения проходят через обычный план;
- `ref` работает только для `repo`-источников; для local это ошибка;
- если у репозитория нет тегов (например `gradle-skills`), пинить можно по
  ветке или sha коммита.

## Инструкции (AGENTS.md)

Раздел `instructions` рендерит управляемые блоки в файл инструкций проекта
(по умолчанию `AGENTS.md`, который OpenCode читает автоматически):

```yaml
instructions:
  blocks:
    build: |
      Сборка: `./gradlew assembleDebug`, тесты: `./gradlew test`.
    versions: |
      Версии зависимостей — только из `gradle/libs.versions.toml`.
      Новые зависимости добавляем после явного согласования.
```

В файле это выглядит так, и всё вне маркеров harness не трогает:

```md
<!-- harness:begin:build -->
Сборка: `./gradlew assembleDebug`, тесты: `./gradlew test`.
<!-- harness:end:build -->
```

- блок, убранный из манифеста, удаляется из файла (state помнит, чем владел);
- правка внутри блока видна как drift и перезаписывается при `apply`;
- повреждённые маркеры (незакрытый/повторный блок) блокируют `apply`, а не
  затирают файл;
- `doctor` проверяет маркеры и существование путей/команд из `inline-code`
  (совет Google: в AGENTS.md — конкретные команды и пути, а не пожелания);
- смена `file` переносит блоки: старые аккуратно убираются из прежнего файла.

## State

`.harness/state.json` (добавляется в `.gitignore`) хранит хеши применённого:
конфиг-ключей, MCP-серверов, содержимого vendor-скиллов, блоков инструкций,
массивов `permissions`/`policies` и markdown-агентов. На этом строятся
идемпотентность apply и детекция drift-а (файл правили вне harness).

Рядом лежат снапшоты для `apply --undo` (`.harness/backups/`, последние 5).
Они тоже игнорируются git — это локальная страховка, а не артефакт проекта.

## Секреты

Манифест коммитится в git, поэтому плейнтекст-секреты в нём — утечка. `plan`,
`doctor` и `add` предупреждают, если находят:

- известные форматы токенов (`sk-…`, `ghp_…`, `AKIA…`, JWT, `AIza…`, …)
- `user:pass@host` в URL
- `Bearer`/`Basic` в заголовке `Authorization`
- значения под ключами вида `apiKey`, `TOKEN`, `dbPassword`
- строки с высокой энтропией без известного префикса (base64url/hex, ≥ 24
  символов, смешанный регистр и цифра; публичные git sha/UUID не флагуются)

Правильная форма — ссылка на окружение:

```yaml
mcp:
  api:
    type: remote
    url: https://example.com/mcp
    headers:
      Authorization: "Bearer {env:MCP_TOKEN}"
```

OpenCode V2 подставляет `{env:VAR}` и `{file:path}` в текст конфига до
парсинга (`packages/core/src/config/variable.ts`), так что значение живёт
только в окружении. Сами значения найденных секретов в вывод не попадают —
только путь и причина.

## Разработка

```bash
npm install
npm run dev -- plan     # запуск без сборки
npm test                # vitest (без сети: local-источники + изолированные XDG)
npm run typecheck
npm run build           # tsc → dist/
```

## Ограничения MVP

- Project-scope: `.opencode/opencode.jsonc` целиком управляется harness;
  в global-scope — только записанные ключи в `~/.config/opencode/opencode.json(c)`
- `instructions` — один файл на проект (по умолчанию `AGENTS.md`); файл
  нормализуется к LF
- `permissions` и `policies` управляются только на top-level; agent-level
  permissions задаются в markdown-агенте
- Агенты — только поддерживаемые поля frontmatter; произвольные поля V2
  (`hidden`, `steps`, `color`, `request`) не рендерятся
- Symlink в reference-режиме на POSIX; на Windows — junction (без прав, но
  только локальные пути, не UNC). Если junction недоступен — `mode: vendor`
- Секреты: аудит — только предупреждения (без блокировки apply); энтропийная
  эвристика намеренно консервативна и не видит токены без смешанного регистра
  (например, lowercase base32)
- MCP-серверы можно задать вручную или взять из официального MCP Registry
  (`harness mcp search|add`); каталог не устанавливает серверы сам и не
  гарантирует безопасность кода — provenance проверяет пользователь
- `diff` для vendor-скиллов показывает уровень файлов, а не построчный diff
  каждого файла (для больших скиллов это осознанно)
- `apply --undo` — локальный стек на 5 снапшотов; манифест не откатывается
- `mcpb`/`nuget` из реестра требуют ручной настройки: автоматический маппинг
  поддержан для `npm`, `pypi`, `oci`, `cargo` и `remotes`
- Codex export не переносит permissions/policies/config/model: Codex использует
  другую модель sandbox/approval и другие ID моделей — это осознанно остаётся
  ручной настройкой
- Codex-файлы генерируются односторонне; правки в Codex ловятся как drift и
  требуют `--force`, обратный импорт в OpenCode не выполняется
