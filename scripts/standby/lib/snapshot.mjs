// Rollback snapshots: the mail records as they were, the change set, and a
// SHA-256 over both so an edited or truncated file is refused. Snapshots
// hold real domain data: they are never overwritten, are created with mode
// 0600 (which only POSIX systems honour; on Windows the folder's permissions
// apply), and belong outside git (standby-snapshots/ is ignored).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const SNAPSHOT_FORMAT = 'cmail-standby-switch-snapshot/1';
export const DEFAULT_SNAPSHOT_DIR = 'standby-snapshots';
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export function fileStamp(date) {
  // 20261115T030000123Z: milliseconds kept so two quick runs never collide.
  return date.toISOString().replace(/[-:.]/g, '');
}

function checksum(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * @param {string} dir
 * @param {{ tool: 'switch'|'switch-back', kind: 'dry-run'|'apply', takenAt: Date, domain: string, zoneId: string, emailRouting: object, records: object, plan: object }} data
 * @returns {Promise<string>} the file written
 */
export async function writeSnapshot(dir, data) {
  const body = {
    format: SNAPSHOT_FORMAT,
    tool: data.tool,
    kind: data.kind,
    takenAt: data.takenAt.toISOString(),
    domain: data.domain,
    zoneId: data.zoneId,
    emailRouting: data.emailRouting,
    records: data.records,
    plan: data.plan,
  };
  const text = `${JSON.stringify({ ...body, checksum: checksum(body) }, null, 2)}\n`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stem = `${data.domain}-${fileStamp(data.takenAt)}-${data.tool}-${data.kind}`;
  for (let n = 1; n <= 20; n += 1) {
    const file = resolve(join(dir, `${stem}${n === 1 ? '' : `-${n}`}.json`));
    try {
      // 'wx': never overwrite an existing snapshot.
      await writeFile(file, text, { flag: 'wx', mode: 0o600 });
      return file;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not find a free snapshot file name.');
}

export async function writeResult(snapshotFile, result) {
  const file = snapshotFile.replace(/\.json$/, '.result.json');
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}

/**
 * Reads and checks a snapshot. Returns { ok, snapshot } or { ok: false, error }.
 */
export async function readSnapshot(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `Cannot read the snapshot (${error.code || 'error'}).` };
  }
  if (text.length > MAX_SNAPSHOT_BYTES) return { ok: false, error: 'The snapshot is too large to be one of ours.' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The snapshot is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.format !== SNAPSHOT_FORMAT) {
    return { ok: false, error: `The file is not a ${SNAPSHOT_FORMAT} snapshot.` };
  }
  const { checksum: stated, ...body } = parsed;
  if (typeof stated !== 'string' || stated !== checksum(body)) {
    return { ok: false, error: 'The snapshot checksum does not match: the file was edited or damaged. Refusing to use it.' };
  }
  if (parsed.tool !== 'switch') {
    return { ok: false, error: 'This snapshot was written by switch-back. Switch back from the snapshot the switch wrote.' };
  }
  const mx = parsed.records?.apexMx;
  const valid = Array.isArray(mx) && mx.every((r) => r && r.type === 'MX' && typeof r.content === 'string'
    && Number.isInteger(r.priority) && r.priority >= 0 && r.priority <= 65535
    // 1 = Auto; 30 is the Enterprise minimum, 60 the others'.
    && Number.isInteger(r.ttl) && (r.ttl === 1 || (r.ttl >= 30 && r.ttl <= 86400))
    && typeof r.name === 'string' && (r.comment === null || typeof r.comment === 'string'));
  if (!valid || !Array.isArray(parsed.records?.apexSpf)) return { ok: false, error: 'The snapshot records are malformed.' };
  if (parsed.kind !== 'apply' && parsed.kind !== 'dry-run') return { ok: false, error: 'The snapshot kind is not recognised.' };
  return { ok: true, snapshot: parsed };
}
