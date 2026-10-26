import os from "node:os"
import path from "node:path"
import { pathExists } from "./core/fs.js"

/**
 * Скоуп управления: проект или глобальная конфигурация пользователя.
 *
 * Все пути харнесса выводятся из Scope, поэтому project- и global-режимы
 * используют один и тот же движок plan/apply/doctor. Глобальный конфиг —
 * личный файл пользователя: harness правит только свои ключи (key-level
 * ownership в state), а не владеет файлом целиком.
 */

export type ScopeKind = "project" | "global"

export interface Scope {
  kind: ScopeKind
  /** базовый каталог для сообщений и относительных путей */
  root: string
  /** каталог конфигурации OpenCode (`.opencode` или `~/.config/opencode`) */
  configDir: string
  /** каталог состояния harness (`.harness` или `~/.config/harness`) */
  harnessDir: string
  manifestFile: string
  stateFile: string
  configFile: string
  skillsDir: string
  agentsDir: string
  /** база для относительного `instructions.file` */
  instructionsBase: string
  /** чужие конфиги, которые могут перекрывать значения (только проект) */
  conflictFiles: string[]
}

export type ScopeInput = string | Scope

function configHome(): string {
  const configured = process.env.XDG_CONFIG_HOME?.trim()
  return configured !== undefined && configured !== "" ? configured : path.join(os.homedir(), ".config")
}

/** Проектный скоуп: всё внутри корня проекта. */
export function projectScope(projectRoot: string): Scope {
  const configDir = path.join(projectRoot, ".opencode")
  const harnessDir = path.join(projectRoot, ".harness")
  return {
    kind: "project",
    root: projectRoot,
    configDir,
    harnessDir,
    manifestFile: path.join(projectRoot, "harness.yaml"),
    stateFile: path.join(harnessDir, "state.json"),
    configFile: path.join(configDir, "opencode.jsonc"),
    skillsDir: path.join(configDir, "skills"),
    agentsDir: path.join(configDir, "agents"),
    instructionsBase: projectRoot,
    conflictFiles: [
      path.join(projectRoot, "opencode.json"),
      path.join(projectRoot, "opencode.jsonc"),
    ],
  }
}

/**
 * Глобальный скоуп: манифест и state — в `~/.config/harness`, артефакты —
 * в `~/.config/opencode`. Существующий `opencode.json` не подменяется
 * второй копией `.jsonc`: harness правит тот файл, который уже есть.
 */
export async function globalScope(): Promise<Scope> {
  const base = configHome()
  const configDir = path.join(base, "opencode")
  const harnessDir = path.join(base, "harness")
  const jsonc = path.join(configDir, "opencode.jsonc")
  const json = path.join(configDir, "opencode.json")
  const configFile = (await pathExists(jsonc)) ? jsonc : (await pathExists(json)) ? json : jsonc
  return {
    kind: "global",
    root: configDir,
    configDir,
    harnessDir,
    manifestFile: path.join(harnessDir, "harness.yaml"),
    stateFile: path.join(harnessDir, "state.json"),
    configFile,
    skillsDir: path.join(configDir, "skills"),
    agentsDir: path.join(configDir, "agents"),
    instructionsBase: configDir,
    conflictFiles: [],
  }
}

export async function resolveScope(
  projectRoot: string,
  options: { global?: boolean } = {},
): Promise<Scope> {
  return options.global === true ? globalScope() : projectScope(projectRoot)
}

/** Нормализация входа: строковый корень проекта или готовый Scope. */
export function scopeFrom(input: ScopeInput): Scope {
  return typeof input === "string" ? projectScope(input) : input
}

/** Путь для сообщений: относительный в проекте, `~/…` в глобальном скоупе. */
export function displayPath(scope: Scope, file: string): string {
  if (scope.kind === "project") return path.relative(scope.root, file) || "."
  const home = os.homedir()
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file
}
