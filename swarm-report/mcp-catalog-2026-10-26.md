# MCP-каталог для `harness add mcp`: research-spike

Дата: 2026-10-26 · Статус: **GO** для официального MCP Registry · **NO-GO** для скрейпинга mcpmarket.com

## Вопрос

Можно ли добавить в harness каталог MCP-серверов, чтобы `harness add mcp` не требовал
помнить точную команду/URL, и при этом не превратить инструмент в канал
автоматической установки недоверенного кода?

## Рассмотренные источники

| Источник | API | Авторизация | Пригодность |
|---|---|---|---|
| Official MCP Registry (`registry.modelcontextprotocol.io`) | REST, OpenAPI, v0.1 | нет (read-only) | **Да** — основной кандидат |
| Smithery (`smithery.ai`) | REST + OpenAPI, поиск по каталогу | API key (Bearer) | Позже, опциональный адаптер |
| mcpmarket.com | публичного API не найдено | — | **Нет**: только HTML-каталог, скрейпинг хрупкий и ToS-рискованный |
| Статические awesome-списки | GitHub raw | нет | Нет: нет версий, install-метаданных и provenance |

## Что даёт Official MCP Registry

Проверено вживую 2026-10-26:

- `GET /v0.1/servers?limit=N&cursor=…` — список серверов, cursor-пагинация,
  `metadata.nextCursor`;
- `GET /v0.1/servers?updated_since=<RFC3339>` — инкрементальная синхронизация;
- `GET /v0.1/servers/{name}/versions` и `…/versions/latest` — версии; имя
  обязательно URL-encode (`ac.inference.sh%2Fmcp`);
- live-эндпоинт принимает `?search=…` (проверено), но в документации этот
  параметр не заявлен → в реализации нельзя на него опираться как на контракт:
  нужен fallback — постраничная загрузка + фильтрация на клиенте;
- ответ — стандартизированный `server.json`: `name`, `title`, `description`,
  `version`, `repository`, `packages[]`, `remotes[]`, `_meta` со `status`;
- `packages[]` содержит `registryType` (`npm`, `pypi`, `nuget`, `cargo`, `oci`,
  `mcpb`), `identifier`, `version`, `transport`, аргументы и переменные
  окружения; `remotes[]` — готовый URL и заголовки, в т.ч. `isSecret: true`;
- статусы `active` / `deprecated` / `deleted`: `deleted` — повод исключить
  сервер из индекса.

### Trust & security

- namespace-верификация: `io.github.user/...` — через GitHub, `com.example/...` —
  через DNS/HTTP-challenge. Это подтверждает **владение именем**, но не
  безопасность кода;
- реестр **не сканирует код**: security scanning делегирован npm/PyPI/Docker и
  downstream-агрегаторам;
- модерация — ручной takedown, статус `deleted`;
- официальная позиция: реестр — для агрегаторов, а не для прямого потребления
  host-приложениями; данные — preview, без гарантий uptime и durability,
  возможны breaking changes и сбросы. Агрегаторам рекомендовано кэшировать
  (например, раз в час) и хранить свой индекс.

Для CLI-инструмента это означает: **кэш обязателен**, сеть не должна быть на
критическом пути `plan/apply`, а каталог — opt-in команда, а не источник
желаемого состояния.

## Решение

**GO**: официальный MCP Registry как read-only источник для отдельной команды
поиска и генерации черновика MCP-записи в манифест.

Жёсткие инварианты:

1. Каталог **никогда не устанавливает и не применяет** сервер сам. Результат —
   только правка `harness.yaml` (как `add mcp`), дальнейшее — обычный
   `plan → apply` с диффом.
2. Секреты — только `{env:VAR}`. `isSecret`-заголовки и required env из
   registry превращаются в ссылки, значения не печатаются и не пишутся.
3. Версия фиксируется в генерируемой команде (`pkg@version`), а не «latest».
4. Сеть недоступна/реестр лёг → понятная ошибка, stale-кэш (если есть) с
   пометкой возраста, никаких падений `plan/apply`.
5. Никакого скрейпинга mcpmarket.com; Smithery — только как явный адаптер с
   ключом пользователя, если official-реестра не хватит.

## Дизайн следующей стадии (не реализовано)

### Команды

```bash
harness mcp search <query> [--json] [--refresh]
harness mcp add <registry-name> [--version latest|<semver>] [--remote|--package <type>]
```

`mcp add` без флагов выбирает: remote, если у сервера есть `remotes[]`; иначе
первый поддерживаемый package.

### Кэш

- `$XDG_DATA_HOME/harness/registry/servers.json` + `meta.json` (fetchedAt,
  nextCursor, etag/updated_since);
- TTL 24 часа; `--refresh` — принудительно; при сетевой ошибке — stale с
  предупреждением;
- схема ответа валидируется zod; неизвестные поля игнорируются, но
  `server.json` schema-version логируется.

### Маппинг в V2-конфиг

| registryType | V2 MCP-запись |
|---|---|
| `npm` | `type: local`, `command: [npx, -y, <identifier>@<version>]` |
| `pypi` | `type: local`, `command: [uvx, <identifier>==<version>]` |
| `oci` | `type: local`, `command: [docker, run, -i, --rm, <identifier>]` |
| `cargo` | `type: local`, `command: [<binary>]` + предупреждение об установке |
| `mcpb` | не поддерживается автоматически — подсказка про ручную настройку |
| `remotes[]` | `type: remote`, `url`, `headers` (секреты → `{env:VAR}`) |

Для `stdio`-пакетов аргументы и env из `server.json` переносятся как есть;
`isSecret`/required env → `{env:NAME}`.

### Тесты

- фикстуры ответов registry (npm/pypi/remote/secret/deleted) — без сети;
- unit: маппинг типов, конвертация секретов, TTL и stale-кэш, fallback поиска;
- e2e: `mcp add` правит манифест, `plan` показывает MCP, `apply` пишет конфиг;
- интеграционный тест с живым registry — только по `HARNESS_REGISTRY_LIVE=1`.

## Риски и открытые вопросы

- `search` не в документированном контракте → фильтрация на клиенте, тест на
  отсутствие параметра;
- preview-статус API: возможны breaking changes → версия API в конфиге клиента
  и мягкая деградация;
- mapping `cargo`/`mcpb`/`oci` требует проверки реальных server.json;
- реестр не гарантирует безопасность кода — UI обязан показывать
  provenance/репозиторий и предупреждать о непроверенных серверах;
- вопрос атрибуции и rate limits: User-Agent `harness-ctl/<version>`,
  кэш вместо запросов на каждый вызов.

## Источники (проверено 2026-10-26)

- https://modelcontextprotocol.io/registry/about
- https://modelcontextprotocol.io/registry/registry-aggregators.md
- https://modelcontextprotocol.io/registry/package-types.md
- https://registry.modelcontextprotocol.io/v0.1/servers (live)
- https://smithery.ai/docs/concepts/registry_search_servers
- https://mcpmarket.com (публичного API не обнаружено)
