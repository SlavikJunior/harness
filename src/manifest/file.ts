export const MANIFEST_FILE = "harness.yaml"

export const OPENCODE_CONFIG_DIR = (projectRoot: string): string => `${projectRoot}/.opencode`

/** Файл, которым владеет harness (пользовательский opencode.json не трогаем). */
export const MANAGED_CONFIG_FILE = (projectRoot: string): string =>
  `${projectRoot}/.opencode/opencode.jsonc`
