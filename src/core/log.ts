import pc from "picocolors"

/** Плоский вывод CLI: метки, варнинги, ошибки. Только stderr — для сообщений. */

export function ok(message: string): void {
  console.log(`${pc.green("✔")} ${message}`)
}

export function info(message: string): void {
  console.log(`${pc.blue("·")} ${message}`)
}

export function warn(message: string): void {
  console.log(`${pc.yellow("⚠")} ${message}`)
}

export function fail(message: string, hint?: string): void {
  console.error(`${pc.red("✖")} ${message}`)
  if (hint) console.error(pc.dim(`  → ${hint}`))
}

export function section(title: string): void {
  console.log("")
  console.log(pc.bold(title))
}

export function dim(message: string): void {
  console.log(pc.dim(message))
}
