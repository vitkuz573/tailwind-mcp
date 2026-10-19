/**
 * File watching.
 *
 * The server must reflect config edits without a restart. Rather than running
 * a real watcher, every read of the design system is guarded by a cheap
 * fingerprint of the files that feed it. When the fingerprint changes, the
 * engine is rebuilt on next use.
 *
 * This is deliberate: a fingerprint check is race-free, needs no open file
 * descriptors, and cannot leak across project switches.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** A file's identity at a point in time: its size and modification time. */
export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

export type Fingerprint = ReadonlyMap<string, FileStamp | null>;

/**
 * Compute a fingerprint for a set of files.
 *
 * A missing file is recorded as `null` so that creating it later changes the
 * fingerprint.
 */
export async function fingerprint(files: readonly string[]): Promise<Fingerprint> {
  const map = new Map<string, FileStamp | null>();
  await Promise.all(
    files.map(async (file) => {
      const absolute = path.resolve(file);
      try {
        const stat = await fs.stat(absolute);
        map.set(absolute, { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        map.set(absolute, null);
      }
    }),
  );
  return map;
}

/** True when two fingerprints describe the same state of the filesystem. */
export function fingerprintsEqual(a: Fingerprint, b: Fingerprint): boolean {
  if (a.size !== b.size) return false;
  for (const [file, stampA] of a) {
    const stampB = b.get(file);
    if (stampA === null || stampB === null || stampB === undefined) {
      if (stampA !== stampB) return false;
      continue;
    }
    if (stampA.size !== stampB.size || stampA.mtimeMs !== stampB.mtimeMs) return false;
  }
  return true;
}
