import ts from "typescript";
import type { SymbolRow } from "../index/index.ts";
import { positionOf } from "./positions.ts";

export type ChangeKind = "added" | "removed" | "signature" | "header" | "body";

/** One changed declaration; `row` is the after row (the before row for `removed`). */
export type DeclarationChange = {
  kind: ChangeKind;
  row: SymbolRow;
  before?: SymbolRow;
  delta?: string;
  surface: boolean;
  /** Impact lines (already indented) printed directly after the declaration line. */
  impact?: string[];
};

export type Status = "added" | "modified" | "deleted";

/** A changed source file with its declaration diff. */
export type SourceReview = { path: string; status: Status; changes: DeclarationChange[]; declarations: number; hidden: boolean };

export type DiagnosticEntry = { severity: "error" | "warning"; path: string; line: number; col: number; text: string; key: string };

/** Added/deleted files with more declarations than this print one summary line. */
export const MAX_LISTED_DECLARATIONS = 10;

const RANK = { error: 0, warning: 1 } as const;

function span(row: SymbolRow): string {
  return row.endLine > row.line ? `${row.line}-${row.endLine}` : String(row.line);
}

export function changeLine(change: DeclarationChange): string {
  const { row } = change;
  switch (change.kind) {
    case "added":
      return `  + ${row.kind}  ${row.fqName}  ${row.accessibility}  ${span(row)}`;
    case "removed":
      return `  - ${row.kind}  ${row.fqName}  ${row.accessibility}  was ${span(row)}`;
    case "signature":
      return `  ~ signature  ${row.fqName}  ${change.before!.signature} -> ${row.signature}  ${span(row)}`;
    case "header":
      return `  ~ header  ${row.fqName}  ${row.accessibility}  ${span(row)}  ${change.delta ?? ""}`;
    case "body":
      return `  ~ body  ${row.fqName}  ${row.accessibility}  ${span(row)}`;
  }
}

/** The file line and its declaration lines (one summary line for large added/deleted files). */
export function sourceLines(file: SourceReview): string[] {
  if (file.status !== "modified" && file.declarations > MAX_LISTED_DECLARATIONS) {
    return [`${file.path}  ${file.status}  (${file.declarations} declarations; get_outline lists them)`];
  }
  const label =
    file.status !== "modified" || file.changes.length === 0 ? ""
    : file.changes.some((c) => c.surface) ? "  surface"
    : "  body-only";
  return [`${file.path}  ${file.status}${label}`, ...file.changes.flatMap((c) => [changeLine(c), ...(c.impact ?? [])])];
}

/** Error/warning entry of a compiler diagnostic, null for suggestions and messages. */
export function diagnosticEntry(diagnostic: ts.Diagnostic): DiagnosticEntry | null {
  const category = diagnostic.category;
  if (category !== ts.DiagnosticCategory.Error && category !== ts.DiagnosticCategory.Warning) return null;
  const severity = category === ts.DiagnosticCategory.Error ? "error" : "warning";
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const head = `${severity} TS${diagnostic.code}: ${message}`;
  if (!diagnostic.file || diagnostic.start === undefined) {
    return { severity, path: "", line: 0, col: 0, text: `  ${head}`, key: `${diagnostic.code}||${message}` };
  }
  const { path, line, col } = positionOf(diagnostic.file, diagnostic.start);
  return { severity, path, line, col, text: `  ${path}:${line}:${col}  ${head}`, key: `${diagnostic.code}|${path}|${diagnostic.start}|${message}` };
}

/** Deduplicated (code, path, start, message) and ordered by severity, path, line, column. */
export function diagnosticLines(entries: DiagnosticEntry[]): { lines: string[]; errors: number; warnings: number } {
  const seen = new Set<string>();
  const kept = entries.filter((e) => !seen.has(e.key) && seen.add(e.key));
  kept.sort((a, b) => {
    const pa = a.path.toLowerCase();
    const pb = b.path.toLowerCase();
    return RANK[a.severity] - RANK[b.severity] || (pa < pb ? -1 : pa > pb ? 1 : 0) || a.line - b.line || a.col - b.col;
  });
  const errors = kept.filter((e) => e.severity === "error").length;
  const lines = kept.length === 0 ? [] : [
    `Diagnostics on changed files: ${errors} errors, ${kept.length - errors} warnings (compiler only; lint is not run)`,
    ...kept.map((e) => e.text),
  ];
  return { lines, errors, warnings: kept.length - errors };
}

// ---- normalized declaration text -----------------------------------------------------------

/** End offset of the part of a declaration that is compared: the header of types and namespaces, else all of it. */
function comparedEnd(node: ts.Node): number {
  if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) return node.members.pos;
  if (ts.isModuleDeclaration(node) && node.body) return node.body.pos;
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) return node.type.members.pos;
  return node.getEnd();
}

/** Source text of the compared part as its tokens joined by one space: comments and formatting do not count. */
export function normalizedText(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const text = sourceFile.text.slice(node.getStart(sourceFile), comparedEnd(node));
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sourceFile.languageVariant, text);
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) tokens.push(scanner.getTokenText());
  return tokens.join(" ");
}

/** `@Name` of every decorator of a declaration (call arguments dropped). */
export function decoratorNames(node: ts.Node): string[] {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  return decorators.map((d) => `@${(ts.isCallExpression(d.expression) ? d.expression.expression : d.expression).getText()}`);
}
