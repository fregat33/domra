import type { IndexStore } from "../index/index.ts";
import type { ReviewIndex } from "../workspace/index.ts";
import { driftTagFor } from "./drift.ts";

/** The index side of the `review_changes` impact lines: reference counts per indexed solution and package drift tags. */
export function reviewIndexFor(store: IndexStore): ReviewIndex {
  return {
    countReferences(docId) {
      const tests = store.countReferencesBySolution(docId, { scope: "tests" });
      return [...store.countReferencesBySolution(docId, {})]
        .filter(([, count]) => count.total > 0)
        .map(([solutionPath, count]) => ({ solutionPath, total: count.total, tests: tests.get(solutionPath)?.kept ?? 0 }));
    },
    driftTag: (docId, solutionPath, hits) => driftTagFor(store, docId, solutionPath, hits),
  };
}
