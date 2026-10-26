import type { PolicyRule } from "../manifest/schema.js"

/**
 * Линты policies V2.
 *
 * Политика — жёсткий deny поверх permissions и сохранённых approvals,
 * поэтому она никогда не «разрешает», а только запрещает. Опасны слишком
 * широкие запреты: включённая политика `*`/`*` делает агента бесполезным
 * и не чинится проектным allow.
 */

export interface PolicyLint {
  /** номер правила, 1-based */
  rule: number
  message: string
}

export function lintPolicies(rules: readonly PolicyRule[]): PolicyLint[] {
  const lints: PolicyLint[] = []
  rules.forEach((rule, index) => {
    const position = index + 1
    if (rule.action === "*" && rule.resource === "*") {
      lints.push({
        rule: position,
        message: `policies[${position}]: "*" / "*" deny блокирует все проверки прав — включая чтение и вопросы`,
      })
      return
    }
    if (rule.action === "read" && rule.resource === "*") {
      lints.push({
        rule: position,
        message: `policies[${position}]: read "*" deny блокирует чтение всех файлов проекта`,
      })
    }
  })
  return lints
}
