/**
 * Deterministic topic keys for clustering evidence about the same mistake.
 *
 * This is the no-LLM baseline. The Forge LLM distiller (src/forge/llm.ts) can
 * merge topics that the heuristic keeps apart, but it never invents evidence.
 */
import { ChangeSummary } from './types';
import { hashId } from './hash';

const IMPORT_RES = [
  /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/,
  /require\(\s*['"]([^'"]+)['"]\s*\)/,
  /^\s*from\s+([\w.]+)\s+import\b/,
  /^\s*import\s+([\w.]+)\s*$/,
];

export function importsIn(lines: string[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    for (const re of IMPORT_RES) {
      const m = re.exec(line);
      if (m?.[1]) out.add(m[1]);
    }
  }
  return [...out];
}

const KEY_RE = /\b([a-zA-Z_][\w]*)\s*[:=]/g;

function keysIn(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) for (const m of l.matchAll(KEY_RE)) if (m[1]) out.add(m[1]);
  return out;
}

/**
 * Topic for a correction, where `removed` is what the human took out of the
 * agent's work and `added` is what they put in.
 */
export function topicFor(change: Pick<ChangeSummary, 'removed' | 'added' | 'files'>): string {
  const removedImports = importsIn(change.removed);
  const addedImports = importsIn(change.added);
  const dropped = removedImports.filter((i) => !addedImports.includes(i));
  const introduced = addedImports.filter((i) => !removedImports.includes(i));

  // Cluster on what was taken away, so a revert (drops axios) and a fix-up
  // (swaps axios for @org/http) land on the same topic.
  if (dropped.length) return `avoid:${dropped.sort()[0]}`;
  if (introduced.length) return `prefer:${introduced.sort()[0]}`;

  const addedKeys = keysIn(change.added);
  const removedKeys = keysIn(change.removed);
  const newKeys = [...addedKeys].filter((k) => !removedKeys.has(k)).sort();
  if (newKeys.length) return `require:${newKeys[0]}`;

  const norm = [...change.removed, '->', ...change.added]
    .join('\n')
    .replace(/\s+/g, ' ')
    .replace(/(['"`]).*?\1/g, 'S')
    .replace(/\d+/g, 'N')
    .trim();
  return `change:${hashId(norm).slice(0, 10)}`;
}

/** The import a human put in place of the one they removed, if any. */
export function preferredReplacement(change: Pick<ChangeSummary, 'removed' | 'added'>): string | undefined {
  const removed = importsIn(change.removed);
  return importsIn(change.added).filter((i) => !removed.includes(i)).sort()[0];
}
