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
harness plan              # предпросмотр изменений (dry-run)
harness apply             # применить (идемпотентно)
harness update            # обновить зеркала источников и применить
harness doctor            # проверки состояния (опционально --live)
```

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

## Что чем управляет

| Артефакт | Механика |
|---|---|
| `.opencode/opencode.jsonc` | Файл **владеет** только harness. Правки — точечные (jsonc-parser), комментарии сохраняются. Пользовательский `opencode.json` никогда не изменяется |
| Скиллы `vendor` | Копия в `.opencode/skills/<name>/` — OpenCode находит их автоматически, в конфиг не пишется |
| Скиллы `reference` | Symlink в `.opencode/skills/<name>` → зеркало источника (Windows: junction). Тоже без записи в конфиг |
| MCP-серверы | `.opencode/opencode.jsonc` → `mcp.servers.<name>`. OpenCode deep-merge'ит по серверам — чужие серверы не затираются |
| `config.*` | Passthrough: значения пишутся как top-level ключи управляемого конфига |
| `permissions` | Top-level массив правил V2 `{ action, resource, effect }` — пишется как есть, порядок значим |
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

Не управляются: `policies` и `agents.<id>.permissions`.

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
конфиг-ключей, MCP-серверов, содержимого vendor-скиллов, блоков инструкций и
массива `permissions`. На этом строятся идемпотентность apply и детекция
drift-а (файл правили вне harness).

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

- Только project-scope (глобальный конфиг не управляется)
- `instructions` — один файл на проект (по умолчанию `AGENTS.md`); файл
  нормализуется к LF
- `permissions` управляются только на top-level; `policies` и
  `agents.<id>.permissions` — вне MVP
- Symlink в reference-режиме на POSIX; на Windows — junction (без прав, но
  только локальные пути, не UNC). Если junction недоступен — `mode: vendor`
- Секреты: аудит — только предупреждения (без блокировки apply); энтропийная
  эвристика намеренно консервативна и не видит токены без смешанного регистра
  (например, lowercase base32)
