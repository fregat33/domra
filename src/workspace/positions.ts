import type ts from "typescript";

/** A printable source position: 1-based line and column, path as given by the program. */
export type Position = { path: string; line: number; col: number };

export function toSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

export function positionOf(sourceFile: ts.SourceFile, offset: number): Position {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return { path: toSlashes(sourceFile.fileName), line: line + 1, col: character + 1 };
}

/** `{path}:{line}:{col}` */
export function formatPosition(position: Position): string {
  return `${position.path}:${position.line}:${position.col}`;
}

/** 0-based offset of a 1-based line/column, or null when outside the file. */
export function offsetOf(sourceFile: ts.SourceFile, line: number, col: number): number | null {
  const starts = sourceFile.getLineStarts();
  if (line < 1 || line > starts.length || col < 1) return null;
  const lineStart = starts[line - 1]!;
  const lineEnd = line < starts.length ? starts[line]! : sourceFile.text.length;
  const offset = lineStart + col - 1;
  return offset <= lineEnd ? offset : null;
}
