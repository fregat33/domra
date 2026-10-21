export const LAYER = "workspace";

export type { SymbolKind } from "./declarations.ts";
export type { DiscoveredSolution } from "./discovery.ts";
export { discoverSolutions, describeSolution, MAX_DISCOVERY_DEPTH, normalizePath, pathKey, readReferences } from "./discovery.ts";
export type { ResolveOptions, SolutionFilter, SolutionStatus } from "./manager.ts";
export { WorkspaceManager } from "./manager.ts";
export type { Position } from "./positions.ts";
export { formatPosition, positionOf } from "./positions.ts";
export type { GroupedText, QueryText } from "./display.ts";
export {
  compactOf, formatGroupedText, formatHeader, formatNotFound, formatQueryText, modifiersOf,
} from "./display.ts";
export type { FindReferencesOptions } from "./references.ts";
export type { Filters } from "./references.ts";
export {
  classifyReference, describeFilters, enclosingOf, findReferencesText, parseFilters, resolveTargets,
} from "./references.ts";
export type { CallGraphOptions } from "./callGraph.ts";
export { getCallGraphText } from "./callGraph.ts";
export type { ExtractContext } from "./extractor.ts";
export { docIdOf, extractDocument, fileScope } from "./extractor.ts";
export type { PackageInfo } from "./packages.ts";
export { clearPackageCache, packageModulePath, packageOf } from "./packages.ts";
export type { IndexOptions, IndexReport } from "./indexer.ts";
export { indexDocuments, indexSolution, isFresh, isStale, removeDocument } from "./indexer.ts";
export type { FindImplementationsOptions } from "./implementations.ts";
export { findImplementationsText } from "./implementations.ts";
export type { DiagnosticsOptions } from "./diagnostics.ts";
export { diagnosticsText, syncOwners } from "./diagnostics.ts";
export type { ChangedFile, GitChanges, GitProvider } from "./git.ts";
export { createGit } from "./git.ts";
export type { ReviewOptions } from "./review.ts";
export type { ReviewIndex } from "./reviewImpact.ts";
export { reviewChangesText } from "./review.ts";
export type { ListMembersOptions } from "./queries.ts";
export { DEFAULT_LIMIT, definition, listMembers, symbolInfo } from "./queries.ts";
export type { OutlineOptions } from "./outline.ts";
export { outline } from "./outline.ts";
export type { FoundSymbol, ResolvedSymbol } from "./resolver.ts";
export { findInSolution, resolveInSolution, toResolved } from "./resolver.ts";
export type { SearchHit, SearchResult } from "./search.ts";
export { formatSearch, searchInSolution, searchWorkspace } from "./search.ts";
export type { LoadedProject, LoadedSolution } from "./solution.ts";
export {
  addRootFile, adoptRootFile, loadSolution, owningProject, projectFileList, projectFilesChanged, removeRootFile, SnapshotHost,
} from "./solution.ts";
export type { NameSpec, PositionSpec, SymbolSpec } from "./symbolSpec.ts";
export { parseSymbolSpec } from "./symbolSpec.ts";
