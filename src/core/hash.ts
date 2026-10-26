/**
 * Стабильная сериализация и структурное сравнение значений —
 * для хешей конфигурационных значений (порядок ключей не важен,
 * порядок массивов важен).
 */

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

/** Структурное равенство: объекты без учёта порядка ключей, массивы — с учётом. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (typeof a !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  const ka = Object.keys(a as Record<string, unknown>).filter(
    (k) => (a as Record<string, unknown>)[k] !== undefined,
  )
  const kb = Object.keys(b as Record<string, unknown>).filter(
    (k) => (b as Record<string, unknown>)[k] !== undefined,
  )
  if (ka.length !== kb.length) return false
  return ka.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}
