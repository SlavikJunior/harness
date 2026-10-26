import os from "node:os"
import path from "node:path"
import { displayPath, type Scope } from "../../scope.js"

/**
 * Пути Codex для project- и global-скоупа.
 *
 * Codex хранит конфиг, глобальные инструкции и кастомных агентов в
 * `$CODEX_HOME` (по умолчанию `~/.codex`), а пользовательские скиллы —
 * в `$HOME/.agents/skills` (это отдельное место, не CODEX_HOME).
 * Project-scope: `.codex/*` и `.agents/skills` в корне проекта.
 */

export interface CodexEnvironment {
  /** подмена $HOME (тесты, изолированные окружения) */
  home?: string
  /** подмена $CODEX_HOME */
  codexHome?: string
}

export interface CodexPaths {
  codexHome: string
  /** пользовательский config Codex (trust и глобальные настройки) */
  userConfigFile: string
  configFile: string
  instructionsFile: string
  agentsDir: string
  skillsDir: string
  stateFile: string
  backupsDir: string
}

function expandHome(value: string, home: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value
}

export function resolveCodexHome(environment: CodexEnvironment = {}): string {
  const home = environment.home ?? os.homedir()
  const configured =
    environment.codexHome ?? (environment.home === undefined ? process.env.CODEX_HOME : undefined)
  if (configured === undefined || configured.trim() === "") return path.join(home, ".codex")
  const expanded = expandHome(configured.trim(), home)
  return path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded)
}

export function codexPaths(scope: Scope, environment: CodexEnvironment = {}): CodexPaths {
  const home = environment.home ?? os.homedir()
  const codexHome = resolveCodexHome(environment)
  const isProject = scope.kind === "project"
  return {
    codexHome,
    userConfigFile: path.join(codexHome, "config.toml"),
    configFile: isProject ? path.join(scope.root, ".codex", "config.toml") : path.join(codexHome, "config.toml"),
    instructionsFile: isProject ? path.join(scope.root, "AGENTS.md") : path.join(codexHome, "AGENTS.md"),
    agentsDir: isProject ? path.join(scope.root, ".codex", "agents") : path.join(codexHome, "agents"),
    skillsDir: isProject ? path.join(scope.root, ".agents", "skills") : path.join(home, ".agents", "skills"),
    stateFile: path.join(scope.harnessDir, "codex-state.json"),
    backupsDir: path.join(scope.harnessDir, "backups-codex"),
  }
}

/** Путь для сообщений без Scope: домашние пути сокращаются до `~`. */
export function displayHomePath(file: string, environment: CodexEnvironment = {}): string {
  const home = environment.home ?? os.homedir()
  if (file === home) return "~"
  if (file.startsWith(`${home}${path.sep}`)) return `~${file.slice(home.length)}`
  return file
}

/** Путь для сообщений: project — относительно корня, global — через `~`. */
export function displayCodexPath(scope: Scope, file: string, environment: CodexEnvironment = {}): string {
  if (scope.kind === "project") return displayPath(scope, file)
  const home = environment.home ?? os.homedir()
  if (file === home) return "~"
  if (file.startsWith(`${home}${path.sep}`)) return `~${file.slice(home.length)}`
  return file
}
