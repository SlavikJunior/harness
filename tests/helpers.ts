import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

/** Общие помощники тестов: временные директории и фикстуры. */

export async function tempDir(prefix = "harness-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function writeFixture(root: string, rel: string, content: string): Promise<string> {
  const file = path.join(root, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, "utf8")
  return file
}

/** Подмена XDG-директорий на изолированные (без сети и пользовательских файлов). */
export function isolateXdg(configHome: string, dataHome: string): () => void {
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    data: process.env.XDG_DATA_HOME,
  }
  process.env.XDG_CONFIG_HOME = configHome
  process.env.XDG_DATA_HOME = dataHome
  return () => {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.config
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous.data
  }
}
