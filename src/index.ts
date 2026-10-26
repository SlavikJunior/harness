export { loadManifest, validateManifestText, MANIFEST_PATH } from "./manifest/load.js"
export {
  manifestSchema,
  type Manifest,
  type SkillEntry,
  type SkillMode,
  type MCPServer,
  type PermissionRule,
  type PolicyRule,
  type AgentDefinition,
  type AgentMode,
} from "./manifest/schema.js"
export { detectStacks, type DetectResult } from "./detect/index.js"
export { buildCatalog, parseFrontmatter, scanMirror, ensureMirror, mirrorsRoot, sourcesFile, loadSources } from "./catalog/index.js"
export { buildDesiredState, catalogRefs, SKILLS_DIR } from "./apply/desired.js"
export { computePlan } from "./apply/plan.js"
export { computeDiff, diffText, type DiffEntry, type DiffLine, type DiffReport } from "./apply/diff.js"
export { loadContext, type HarnessContext } from "./apply/context.js"
export { applyDesired } from "./apply/apply.js"
export {
  createBackup,
  listBackups,
  restoreBackup,
  BACKUP_RETENTION,
  type BackupEntry,
  type BackupRecord,
  type RestoreOutcome,
} from "./apply/backup.js"
export { createReferenceLink, normalizeLinkTarget, sameLinkTarget } from "./apply/link.js"
export { agentFilePath, agentRelativePath, normalizeAgentContent, renderAgent } from "./apply/agents.js"
export {
  DEFAULT_INSTRUCTIONS_FILE,
  canonicalInstructionsText,
  extractInstructionPaths,
  instructionsFilePath,
  parseInstructionBlocks,
  renderInstructionBlocks,
  type InstructionBlock,
} from "./apply/instructions.js"
export { loadState, saveState, STATE_FILE } from "./apply/state.js"
export { runDoctor } from "./verify/doctor.js"
export { autoFix, unsafeReasons, type AutoFixResult } from "./verify/fix.js"
export {
  changedUpstreams,
  parseLsRemote,
  resolveUpstreamRefs,
  upstreamKey,
  type UpstreamResolution,
  type UpstreamState,
} from "./catalog/upstream.js"
export {
  createRegistryClient,
  draftFromRegistry,
  registryCacheRoot,
  registryServerView,
  sanitizeMcpName,
  summarizeTransport,
  type RegistryClient,
  type RegistryClientOptions,
  type RegistryDraft,
  type RegistryDraftOptions,
  type RegistrySearchResult,
  type RegistryServer,
  type RegistryServerView,
} from "./registry/index.js"
export { scanManifest, classifyValue, maskSecrets, maskText, SECRET_MASK, type SecretFinding, type SecretKind } from "./secrets/scan.js"
export {
  displayPath,
  globalScope,
  projectScope,
  resolveScope,
  scopeFrom,
  type Scope,
  type ScopeInput,
  type ScopeKind,
} from "./scope.js"
export { MANAGED_CONFIG_FILE, MANIFEST_FILE, OPENCODE_CONFIG_DIR } from "./manifest/file.js"
