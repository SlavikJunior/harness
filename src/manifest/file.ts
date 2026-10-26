import { scopeFrom, type ScopeInput } from "../scope.js"

export const MANIFEST_FILE = "harness.yaml"

export const OPENCODE_CONFIG_DIR = (input: ScopeInput): string => scopeFrom(input).configDir

/** Управляемый конфиг: project — `.opencode/opencode.jsonc`, global — существующий `.json(c)`. */
export const MANAGED_CONFIG_FILE = (input: ScopeInput): string => scopeFrom(input).configFile
