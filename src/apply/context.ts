import { loadManifest } from "../manifest/load.js"
import { buildCatalog } from "../catalog/index.js"
import { buildDesiredState, catalogRefs } from "./desired.js"
import { computePlan } from "./plan.js"
import { loadState } from "./state.js"
import type { DesiredState, PlanReport } from "./types.js"
import type { HarnessState } from "./state.js"
import type { Manifest } from "../manifest/schema.js"
import { resolveScope, scopeFrom, type Scope, type ScopeInput } from "../scope.js"

/**
 * Контекст команды: манифест → каталог → желаемое состояние → план.
 *
 * Один и тот же порядок нужен plan/apply/update/diff/doctor --fix; общая
 * функция гарантирует, что команды видят одинаковый план и не расходятся
 * в трактовке состояния.
 */

export interface HarnessContext {
  scope: Scope
  manifest: Manifest
  desired: DesiredState
  state: HarnessState
  plan: PlanReport
}

export async function loadContext(
  input: ScopeInput,
  options: { refresh?: boolean } = {},
): Promise<HarnessContext> {
  const scope = scopeFrom(input)
  const manifest = await loadManifest(scope)
  const refs = catalogRefs(manifest)
  const catalog = await buildCatalog({
    refresh: options.refresh,
    refs,
    sourceFilter: Object.keys(refs),
  })
  const desired = buildDesiredState(scope, manifest, catalog)
  const state = await loadState(scope)
  const plan = await computePlan(scope, desired, state)
  return { scope, manifest, desired, state, plan }
}

/** Для команд, которые строят Scope сами (`--global`). */
export async function loadContextFor(
  projectRoot: string,
  options: { refresh?: boolean; global?: boolean } = {},
): Promise<HarnessContext> {
  return loadContext(await resolveScope(projectRoot, { global: options.global }), {
    refresh: options.refresh,
  })
}
