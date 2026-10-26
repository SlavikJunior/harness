/**
 * Ошибки утилиты harness. Все ожидаемые ошибки — подклассы HarnessError,
 * чтобы CLI печатал их аккуратно (одна строка + подсказка), а не стектрейс.
 */
export class HarnessError extends Error {
  /** Подсказка пользователю, что делать дальше. */
  hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = "HarnessError"
    this.hint = hint
  }
}

/** Одна ошибка валидации с позицией на строку манифеста. */
export interface ValidationIssue {
  /** Путь к полю, например `mcp.playwright.type` */
  path: string
  /** Строковое описание проблемы. */
  message: string
  /** 1-базированный номер строки в файле, если известен. */
  line?: number
}

export class ManifestValidationError extends HarnessError {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[], file: string) {
    super(`Манифест ${file} содержит ошибки`)
    this.name = "ManifestValidationError"
    this.issues = issues
    this.hint = "Исправь перечисленные поля. Проверить текущее состояние: harness plan"
  }
}
