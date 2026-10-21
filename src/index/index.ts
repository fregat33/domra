export const LAYER = "index";

export type { MatchQuality, Query, RankedRecord, SymbolRecord } from "./ranker.ts";
export {
  compareRecords,
  containersMatch,
  humpStarts,
  isHumpStart,
  kindRank,
  match,
  matchesHumps,
  matchRank,
  parseQuery,
} from "./ranker.ts";
export { isTestProject } from "./projectKinds.ts";
export type {
  DocumentRow, DriftRow, Extraction, IndexStats, PackageConsumer, PackageRef, ProjectInfo, ProjectRow, ReferenceFilter, ReferenceHit,
  ReferenceRow, ReferenceScope, RelationHit, RelationRow, SymbolHit, SymbolRow, TreeEntry,
} from "./types.ts";
export type { DocIdParts } from "./docId.ts";
export { makeDocId, parseDocId, scopeOf, stripExtension, TOP_LEVEL } from "./docId.ts";
export { contentHash, decodeText, surfaceHash } from "./hash.ts";
export { defaultIndexPath } from "./paths.ts";
export type { OpenOptions } from "./store.ts";
export { formatStats, IndexStore, SCHEMA_VERSION } from "./store.ts";
export { relativeToSolution } from "./storeQueries.ts";
