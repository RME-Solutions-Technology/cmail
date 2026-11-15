#!/usr/bin/env node
// Standby switch-back: restore the domain's original MX records (and SPF, if
// the switch changed it) from the snapshot the switch wrote. DRY RUN unless
// --apply is given AND the domain is typed at an interactive terminal. DNS
// changes are run by a person, after the owner's yes. Runbook:
// docs/standby-switch.md.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './lib/cloudflare.mjs';
import { checkZone, classifyMailRecords, normaliseDomain, planSwitchBack, verifyMx } from './lib/mail-dns.mjs';
import { DEFAULT_SNAPSHOT_DIR, readSnapshot, writeResult, writeSnapshot } from './lib/snapshot.mjs';
import {
  EXIT,
  Refusal,
  formatRecord,
  isDefiniteRefusal,
  parseOrRefuse,
  realDeps,
  refuseApplyInCi,
  reportFailure,
  rereadWithRetry,
  token,
} from './lib/cli.mjs';

const LABEL_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Copy-back window margin after switch-back: senders with cached Cloudflare MX and retries. */
const COPY_BACK_MARGIN_MS = 60 * 60 * 1000;
/**
 * Statuses in which Email Routing's root records are locked: "ready" (onboarding
 * locks the records it creates) and "misconfigured/locked". Not "unlocked" or
 * "misconfigured".
 */
const LOCKED_STATUSES = new Set(['ready', 'misconfigured/locked']);

export const SWITCH_BACK_HELP = `Usage: node scripts/standby/switch-back.mjs --domain <apex> --snapshot <file> [options]

Restores the apex MX records (and SPF, if the switch changed it) from the
snapshot the switch wrote, in one DNS change. Dry run unless --apply. Never run
--apply without the owner's yes. Read docs/standby-switch.md first.

  --domain <apex>            The mail domain (must match the snapshot).
  --snapshot <file>          The snapshot switch.mjs --apply saved before the switch.
  --apply                    Make the change (asks you to type the domain).
  --allow-dry-run-snapshot   Accept a dry-run snapshot (First-time setup only).
  --skip-unlock              Do not ask Cloudflare to unlock Email Routing's records
                             (use after unlocking them by hand in the dashboard).
  --standby-label <label>    The standby subdomain label (default "standby").
  --snapshot-dir <dir>       Where this run's own snapshot goes (default ./${DEFAULT_SNAPSHOT_DIR}).

Environment: CLOUDFLARE_API_TOKEN (never printed).
Exit codes: 0 done or nothing to do; 1 nothing changed (refused or failed);
2 applied but not as planned; 3 outcome unknown (read the output, check DNS);
4 records were unlocked but the MX change was refused (MX unchanged).`;

function parse(argv) {
  const { values } = parseOrRefuse({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      domain: { type: 'string' },
      snapshot: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'allow-dry-run-snapshot': { type: 'boolean', default: false },
      'skip-unlock': { type: 'boolean', default: false },
      'standby-label': { type: 'string' },
      'snapshot-dir': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  const domain = normaliseDomain(values.domain);
  if (!domain) throw new Refusal('--domain must be a domain name such as example.com.');
  if (!values.snapshot) throw new Refusal('--snapshot is required: the file switch.mjs saved before the switch.');
  const standbyLabel = String(values['standby-label'] ?? 'standby').trim().toLowerCase();
  if (!LABEL_RX.test(standbyLabel)) throw new Refusal('--standby-label must be one DNS label.');
  return {
    help: false,
    domain,
    snapshot: values.snapshot,
    apply: values.apply,
    allowDryRunSnapshot: values['allow-dry-run-snapshot'],
    skipUnlock: values['skip-unlock'],
    standbyLabel,
    snapshotDir: values['snapshot-dir'] ?? DEFAULT_SNAPSHOT_DIR,
  };
}

async function readMailRecords(client, zoneId, domain, standbyLabel) {
  const [mx, txt, cname] = await Promise.all([
    client.listRecords(zoneId, 'MX'),
    client.listRecords(zoneId, 'TXT'),
    client.listRecords(zoneId, 'CNAME'),
  ]);
  return classifyMailRecords(domain, { mx, txt, cname }, standbyLabel);
}

function standbyMailAdvice(out, snapshot, now) {
  const start = snapshot.takenAt;
  const end = new Date(now.getTime() + COPY_BACK_MARGIN_MS).toISOString();
  out('');
  out('Mail that arrived in cmail while switched:');
  out('  - It stays in cmail; nothing is moved or deleted. People can keep reading it there.');
  out('  - Senders that cached the Cloudflare MX, and retries, can keep arriving in cmail for a while');
  out('    (up to the MX TTL, longer for retries). The catch-all is left sending to the Worker so they are not lost.');
  out('  - To get it into Outlook, use Admin > Copy back to Exchange (docs/copy-back.md):');
  out(`    window ${start} to ${end} (UTC). Start it after the end time; messages Exchange`);
  out('    already has are skipped by Message-ID, so a wide window is safe.');
  out('  - Mail Microsoft accepted itself during the outage is already in Exchange; copy-back skips it.');
}

/**
 * @returns {Promise<number>} see EXIT in lib/cli.mjs
 */
export async function runSwitchBack(argv, deps) {
  const { out } = deps;
  let redact = (text) => text;
  try {
    const opts = parse(argv);
    if (opts.help) {
      out(SWITCH_BACK_HELP);
      return EXIT.DONE;
    }
    if (opts.apply) refuseApplyInCi(deps.env);
    const client = createClient({ token: token(deps.env), fetch: deps.fetch });
    redact = client.redact;
    const now = deps.now();

    out(`cmail standby switch-back: ${opts.apply ? 'APPLY (will change live DNS after you confirm)' : 'DRY RUN (nothing will change)'}`);
    out(`Domain: ${opts.domain}`);

    const read = await readSnapshot(opts.snapshot);
    if (!read.ok) throw new Refusal(read.error);
    const snapshot = read.snapshot;
    if (snapshot.domain !== opts.domain) throw new Refusal(`The snapshot is for ${snapshot.domain}, not ${opts.domain}.`);
    if (snapshot.kind !== 'apply' && !opts.allowDryRunSnapshot) {
      throw new Refusal([
        'This is a dry-run snapshot. After a real switch, use the snapshot the --apply run saved (it says "Rollback snapshot saved and checked").',
        'Only First-time setup switches back from a dry-run snapshot; then add --allow-dry-run-snapshot.',
      ]);
    }
    out(`Snapshot: ${resolve(opts.snapshot)} (${snapshot.kind}, taken ${snapshot.takenAt})`);

    const zoneCheck = checkZone(await client.findZones(opts.domain), opts.domain);
    if (!zoneCheck.ok) throw new Refusal(zoneCheck.error);
    const zone = zoneCheck.zone;
    if (zone.id !== snapshot.zoneId) throw new Refusal('The zone id differs from the snapshot\'s: the zone was re-created. Restore by hand from the snapshot file.');
    out(`Zone: ${zone.id}`);

    const settings = await client.emailRoutingSettings(zone.id);
    out(`Email Routing: ${settings?.enabled === true ? 'enabled' : 'not enabled'}, status ${settings?.status ?? 'unknown'}`);
    // Locked records cannot be deleted; unlocking is Cloudflare's documented
    // step before pointing MX at another provider.
    const unlock = !opts.skipUnlock && settings?.enabled === true && LOCKED_STATUSES.has(settings.status);

    const mail = await readMailRecords(client, zone.id, opts.domain, opts.standbyLabel);
    out('');
    out('Mail records now:');
    for (const r of [...mail.apexMx, ...mail.apexSpf]) out(`  ${formatRecord(r)}`);
    if (!mail.apexMx.length) out('  (no apex MX records)');

    const plan = planSwitchBack({ snapshot, mail });
    if (!plan.ok) throw new Refusal(plan.error);
    if (plan.nothingToDo) {
      out('');
      out('The apex MX records already match the snapshot. Nothing to do.');
      if (plan.spf.action === 'leave') out(`  ! ${plan.spf.note}`);
      return EXIT.DONE;
    }

    out('');
    out('Change set (one DNS batch: all of it or none of it):');
    if (unlock) out(`  * first unlock Email Routing's DNS records (status "${settings.status}"; API PATCH email/routing/dns)`);
    if (opts.skipUnlock) out('  * unlock skipped (--skip-unlock): the records must already be unlocked, or the batch is refused');
    for (const r of plan.describe.deletes) out(`  - delete  ${formatRecord(r)}`);
    for (const r of plan.describe.posts) out(`  + add     ${formatRecord(r)}`);
    if (plan.describe.spf) out(`  ~ edit    TXT ${opts.domain} SPF\n      from ${plan.describe.spf.before}\n      to   ${plan.describe.spf.after}`);
    out(`  SPF: ${plan.spf.note}`);
    out('  Restored: host, priority, TTL and comment of each original MX record (tags and record ids are not restored).');
    out('  Routing rules, the catch-all, the standby subdomain and Email Routing itself are left as they are.');

    if (!opts.apply) {
      standbyMailAdvice(out, snapshot, now);
      out('');
      out('Dry run only. To apply, the owner says yes, then a person runs this again with --apply.');
      return EXIT.DONE;
    }

    out('');
    out(`About to change the live MX records of ${opts.domain} back to the snapshot. New mail will go to the original provider.`);
    const answer = await deps.prompt(`Type the domain name (${opts.domain}) to go ahead, anything else to stop: `);
    if (String(answer ?? '').trim().toLowerCase() !== opts.domain) throw new Refusal('The confirmation did not match.');

    const fresh = await readMailRecords(client, zone.id, opts.domain, opts.standbyLabel);
    if (JSON.stringify(fresh.apexMx) !== JSON.stringify(mail.apexMx) || JSON.stringify(fresh.apexSpf) !== JSON.stringify(mail.apexSpf)) {
      throw new Refusal('The MX or SPF records changed since they were read. Run the dry run again.');
    }

    const ownSnapshot = await writeSnapshot(opts.snapshotDir, {
      tool: 'switch-back',
      kind: 'apply',
      takenAt: now,
      domain: opts.domain,
      zoneId: zone.id,
      emailRouting: { enabled: settings?.enabled === true, status: settings?.status ?? null },
      records: fresh,
      plan: { fromSnapshot: resolve(opts.snapshot) },
    });
    out(`This run's snapshot (records before switch-back): ${ownSnapshot}`);
    const redo = `node scripts/standby/switch-back.mjs --domain ${opts.domain} --snapshot "${resolve(opts.snapshot)}"${snapshot.kind === 'apply' ? '' : ' --allow-dry-run-snapshot'}`;

    // From here on something may change: never report "nothing changed" unless it is certain.
    let unlockState = 'none';
    if (unlock) {
      try {
        await client.unlockEmailRoutingDns(zone.id);
        unlockState = 'done';
        out('Unlocked Email Routing\'s DNS records.');
      } catch (error) {
        unlockState = isDefiniteRefusal(error) ? 'refused' : 'unknown';
        out(`! Unlock ${unlockState === 'refused' ? 'was refused' : 'outcome unknown'} (${redact(error?.message || String(error))}).`);
        out('  Going on: if the records are still locked, Cloudflare refuses the batch and the MX stay as they are.');
        out('  Then unlock them in Email Routing > Settings > DNS records and run again with --skip-unlock.');
      }
    }

    try {
      await client.batchRecords(zone.id, plan.batch);
    } catch (error) {
      if (isDefiniteRefusal(error)) {
        await writeResult(ownSnapshot, { applied: false, unlock: unlockState, at: deps.now().toISOString(), error: redact(error.message) }).catch(() => {});
        out('');
        out(`STOPPED: Cloudflare refused the DNS batch (${redact(error.message)}). The MX records are unchanged.`);
        if (unlockState === 'done') {
          out('Email Routing\'s records were unlocked before the refusal; that is the only change. Fix the cause and run again.');
          return EXIT.UNLOCKED_ONLY;
        }
        if (unlockState === 'unknown') {
          out('Whether the unlock took effect is unknown. Check Email Routing > Settings.');
          return EXIT.UNKNOWN;
        }
        out('Nothing was changed.');
        return EXIT.NOTHING_CHANGED;
      }
      out('');
      out(`OUTCOME UNKNOWN: the DNS batch call failed without a clear answer (${redact(error?.message || String(error))}).`);
      out('Cloudflare may or may not have applied it. Reading the records again:');
      const nowRecords = await rereadWithRetry(() => readMailRecords(client, zone.id, opts.domain, opts.standbyLabel), deps);
      if (nowRecords) {
        for (const r of [...nowRecords.apexMx, ...nowRecords.apexSpf]) out(`  ${formatRecord(r)}`);
        out(verifyMx(nowRecords, plan.expectedMx).ok ? 'It looks APPLIED: the apex MX match the snapshot.' : 'It does not look applied (or only partly). Check the dashboard now.');
        await writeResult(ownSnapshot, { applied: 'unknown', at: deps.now().toISOString(), apexMx: nowRecords.apexMx, apexSpf: nowRecords.apexSpf }).catch(() => {});
      } else {
        out('  The records could not be read. Check DNS > Records in the dashboard now.');
      }
      out(`Snapshot used: ${resolve(opts.snapshot)}`);
      out('To finish (safe whatever the state; it does nothing if already restored; dry run first):');
      out(`  ${redo}`);
      return EXIT.UNKNOWN;
    }
    out('Applied the DNS batch.');

    const after = await rereadWithRetry(() => readMailRecords(client, zone.id, opts.domain, opts.standbyLabel), deps);
    if (!after) {
      out('');
      out('OUTCOME UNKNOWN: Cloudflare accepted the batch, but the records could not be read back.');
      out(`Check DNS > Records in the dashboard now. To check or finish: ${redo}`);
      return EXIT.UNKNOWN;
    }
    const mxCheck = verifyMx(after, plan.expectedMx);
    const spfOk = !plan.describe.spf || (after.apexSpf.length === 1 && after.apexSpf[0].content === plan.describe.spf.after);
    await writeResult(ownSnapshot, {
      applied: true,
      at: deps.now().toISOString(),
      verified: mxCheck.ok && spfOk,
      apexMx: after.apexMx,
      apexSpf: after.apexSpf,
    }).catch((error) => out(`  ! Could not write the result file (${error?.code || 'error'}).`));
    out('');
    out('Mail records after:');
    for (const r of [...after.apexMx, ...after.apexSpf]) out(`  ${formatRecord(r)}`);
    if (!mxCheck.ok || !spfOk) {
      out('');
      out('WARNING: the records are not as planned. Check them in the dashboard now against the snapshot.');
      if (mxCheck.missing.length) out(`  missing MX: ${mxCheck.missing.join(', ')}`);
      if (mxCheck.extra.length) out(`  unexpected MX: ${mxCheck.extra.join(', ')}`);
      if (!spfOk) out('  SPF is not what was planned.');
      return EXIT.NOT_AS_PLANNED;
    }
    if (plan.spf.action === 'leave') out(`  ! ${plan.spf.note}`);
    standbyMailAdvice(out, snapshot, now);
    out('');
    out('Done. Verify with docs/standby-switch.md, "Switch back", step 3.');
    return EXIT.DONE;
  } catch (error) {
    return reportFailure(error, out, redact);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runSwitchBack(process.argv.slice(2), realDeps());
}
