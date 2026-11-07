import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short stable id derived from content. */
export function hashId(input: string): string {
  return sha256(input).slice(0, 16);
}
