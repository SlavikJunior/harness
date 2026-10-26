import type { Manifest } from "../manifest/schema.js"

/**
 * Аудит плейнтекст-секретов в манифесте.
 *
 * `harness.yaml` обычно коммитится в git, поэтому ключи и токены в нём —
 * прямой путь к утечке. Правильная форма — ссылка `{env:VAR}`: OpenCode V2
 * подставляет её в текст конфига до парсинга JSONC
 * (packages/core/src/config/variable.ts), поэтому значение живёт только
 * в окружении.
 *
 * Значения найденных секретов НИКОГДА не попадают в отчёт: только путь
 * и причина, иначе аудит сам утекал бы в логи CI.
 */

export type SecretKind = "pattern" | "url-credentials" | "auth-header" | "keyword"

export interface SecretFinding {
  /** dot-path поля манифеста, например `mcp.playwright.headers.Authorization` */
  path: string
  kind: SecretKind
  /** причина без самого значения */
  reason: string
}

interface TokenPattern {
  label: string
  re: RegExp
}

/** Известные форматы токенов: узнаваемые префиксы дают мало ложных срабатываний. */
const TOKEN_PATTERNS: readonly TokenPattern[] = [
  { label: "ключ OpenAI/Anthropic", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/ },
  { label: "ключ Stripe", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/ },
  { label: "токен GitHub", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { label: "ключ AWS", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "токен Slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "токен GitLab", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { label: "токен npm", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { label: "ключ Google API", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "токен Telegram-бота", re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/ },
  { label: "webhook Slack", re: /https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/ },
  { label: "webhook Stripe", re: /\bwhsec_[A-Za-z0-9]{20,}\b/ },
  { label: "приватный ключ", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

/** Ссылка на env/file — рекомендованная форма, не секрет. */
const REFERENCE_RE = /\{(?:env|file):[^}]+\}/

/** Учётные данные в URL: `postgres://user:pass@host/db`. */
const URL_CREDENTIALS_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@:]+:[^/\s@]+@/i

/** Заголовок с явной схемой авторизации: `Bearer …`, `Basic …`. */
const AUTH_VALUE_RE = /^(?:bearer|basic|token)\s+\S+/i

const AUTH_KEYS = new Set(["authorization", "proxy-authorization"])

/** Нормализованные окончания имён, указывающие на секрет (apiKey, GITHUB_TOKEN, db-password). */
const SECRET_KEY_SUFFIXES = [
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "authkey",
  "secret",
  "token",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "credential",
  "credentials",
  "authorization",
]

/** Заглушки и примеры — не секреты, иначе предупреждения превращаются в шум. */
const PLACEHOLDER_RE =
  /^(?:<[^>]*>|\$\{[^}]*\}|x{3,}|\*{3,}|\.{3}|changeme|placeholder|todo|example|your[-_ ].*|test[-_].*)$/i

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, "")
}

function looksLikeSecretKey(key: string | undefined): boolean {
  if (key === undefined) return false
  const normalized = normalizeKey(key)
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value.trim())
}

interface Classification {
  kind: SecretKind
  reason: string
}

/** Классификация значения; undefined — не похоже на секрет. */
export function classifyValue(key: string | undefined, value: string): Classification | undefined {
  if (value.trim() === "" || REFERENCE_RE.test(value) || isPlaceholder(value)) return undefined

  for (const pattern of TOKEN_PATTERNS) {
    if (pattern.re.test(value)) return { kind: "pattern", reason: `похоже на ${pattern.label}` }
  }
  if (URL_CREDENTIALS_RE.test(value)) {
    return { kind: "url-credentials", reason: "в URL логин и пароль в плейнтексте" }
  }
  if (key !== undefined && AUTH_KEYS.has(normalizeKey(key)) && AUTH_VALUE_RE.test(value.trim())) {
    return { kind: "auth-header", reason: "токен авторизации в плейнтексте" }
  }
  if (looksLikeSecretKey(key)) {
    return { kind: "keyword", reason: "имя поля указывает на секрет, значение в плейнтексте" }
  }
  return undefined
}

type PathSegment = string | number

function joinPath(parts: readonly PathSegment[]): string {
  return parts.reduce<string>(
    (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc === "" ? part : `${acc}.${part}`),
    "",
  )
}

/** Ближайший строковый сегмент пути — подсказка для эвристики по имени ключа. */
function nearestKey(parts: readonly PathSegment[]): string | undefined {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (typeof part === "string") return part
  }
  return undefined
}

interface ScanContext {
  findings: SecretFinding[]
  seen: Set<string>
}

function checkValue(path: readonly PathSegment[], keyHint: string | undefined, value: string, context: ScanContext): void {
  const classified = classifyValue(keyHint, value)
  if (classified === undefined) return
  const text = joinPath(path)
  if (context.seen.has(text)) return
  context.seen.add(text)
  context.findings.push({ path: text, kind: classified.kind, reason: classified.reason })
}

/** Рекурсивный обход passthrough-конфига: строки на любой глубине. */
function walkConfig(value: unknown, path: PathSegment[], context: ScanContext): void {
  if (typeof value === "string") {
    checkValue(path, nearestKey(path), value, context)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkConfig(item, [...path, index], context))
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) walkConfig(nested, [...path, key], context)
  }
}

/**
 * Поиск плейнтекст-секретов в манифесте (чистая функция).
 * Сканируются только поля, которые попадут в конфиг OpenCode:
 * MCP-серверы и passthrough `config`.
 */
export function scanManifest(manifest: Manifest): SecretFinding[] {
  const context: ScanContext = { findings: [], seen: new Set() }

  for (const [name, server] of Object.entries(manifest.mcp ?? {})) {
    if (server.type === "local") {
      server.command.forEach((argument, index) => {
        checkValue(["mcp", name, "command", index], undefined, argument, context)
      })
      for (const [key, value] of Object.entries(server.environment ?? {})) {
        checkValue(["mcp", name, "environment", key], key, value, context)
      }
    } else {
      checkValue(["mcp", name, "url"], "url", server.url, context)
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        checkValue(["mcp", name, "headers", key], key, value, context)
      }
    }
  }

  walkConfig(manifest.config ?? {}, ["config"], context)
  return context.findings
}

/** Маркер скрытого значения в выводе CLI (сам секрет не печатается). */
export const SECRET_MASK = "•••"

/** Маскировка текста: userinfo в URL прячется точечно, остальное — целиком. */
export function maskText(value: string, keyHint?: string): string {
  if (classifyValue(keyHint, value) === undefined) return value
  if (URL_CREDENTIALS_RE.test(value)) {
    return value.replace(URL_CREDENTIALS_RE, (prefix) => `${prefix.split("://")[0]}://${SECRET_MASK}@`)
  }
  return SECRET_MASK
}

/**
 * Рекурсивная маскировка значений для вывода плана: план и doctor не должны
 * печатать секреты, иначе аудит теряет смысл.
 */
export function maskSecrets(value: unknown, keyHint?: string): unknown {
  if (typeof value === "string") return maskText(value, keyHint)
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, maskSecrets(nested, key)]))
  }
  return value
}
