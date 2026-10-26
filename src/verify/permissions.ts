import type { PermissionRule } from "../manifest/schema.js"

/**
 * Линты permissions V2.
 *
 * В V2 базовые правила разрешают почти всё (`*`/`*` allow), а `.env`-файлы
 * по умолчанию требуют подтверждения. Поэтому предупреждаем только о том,
 * что реально меняет дефолт: ослабление защиты `.env` чтением и тотальный
 * deny, который блокирует всё, включая нужные инструменты.
 */

export interface PermissionLint {
  /** номер правила, 1-based — как в массиве манифеста */
  rule: number
  message: string
}

/** Пути, которые V2 по умолчанию защищает (кроме `.env.example`). */
const SENSITIVE_ENV_PATHS = [".env", ".env.local", "config/.env"] as const

/** Полное совпадение по wildcard-правилам V2: `*` — любые символы, `?` — один. */
export function wildcardMatch(pattern: string, value: string): boolean {
  const matches = (candidate: string): boolean => {
    let source = "^"
    for (const char of candidate) {
      if (char === "*") source += "[\\s\\S]*"
      else if (char === "?") source += "[\\s\\S]"
      else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
    return new RegExp(`${source}$`, "i").test(value)
  }
  if (matches(pattern)) return true
  /* V2: шаблон команды, оканчивающийся на " *", матчит и команду без аргументов */
  return pattern.endsWith(" *") ? matches(pattern.slice(0, -2)) : false
}

export function lintPermissions(rules: readonly PermissionRule[]): PermissionLint[] {
  const lints: PermissionLint[] = []
  rules.forEach((rule, index) => {
    const position = index + 1

    if (rule.action === "read" && rule.effect === "allow") {
      const loosensEnv = SENSITIVE_ENV_PATHS.some((envPath) => wildcardMatch(rule.resource, envPath))
      if (loosensEnv) {
        lints.push({
          rule: position,
          message: `permissions[${position}]: read allow "${rule.resource}" открывает .env без подтверждения (по умолчанию V2 спрашивает)`,
        })
      }
    }

    if (rule.action === "*" && rule.resource === "*" && rule.effect === "deny") {
      lints.push({
        rule: position,
        message: `permissions[${position}]: "*" / "*" deny блокирует все действия — проверь порядок и что это задумано`,
      })
    }
  })
  return lints
}
