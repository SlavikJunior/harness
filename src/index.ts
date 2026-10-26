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
export { applyDesired } from "./apply/apply.js"
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
