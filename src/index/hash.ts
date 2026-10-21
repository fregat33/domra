import { createHash } from "node:crypto";
import type { Extraction } from "./types.ts";

const BOM = "﻿";

/** UTF-8 text of a file buffer without a leading byte-order mark. */
export function decodeText(buffer: Uint8Array): string {
  const text = Buffer.from(buffer).toString("utf8");
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** SHA-256 of the UTF-8 text (a leading BOM is ignored), lowercase hex. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text.startsWith(BOM) ? text.slice(1) : text, "utf8").digest("hex");
}

/** SHA-256 over the sorted public surface: non-private symbols and relations. */
export function surfaceHash(extraction: Extraction): string {
  const lines: string[] = [];
  for (const s of extraction.symbols) {
    if (s.accessibility !== "private") lines.push(`S\t${s.docId}\t${s.signature}\t${s.accessibility}`);
  }
  for (const r of extraction.relations) lines.push(`R\t${r.fromDocId}\t${r.toDocId}\t${r.kind}`);
  lines.sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
