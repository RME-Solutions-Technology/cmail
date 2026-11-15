#!/usr/bin/env node
// Standby switch: point a domain's mail at cmail (Cloudflare Email Routing)
// in one DNS change. DRY RUN unless --apply is given AND the domain is typed
// at an interactive terminal. DNS changes are run by a person, after the
// owner's yes. Runbook, limits and what is proven: docs/standby-switch.md.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, CloudflareError } from './lib/cloudflare.mjs';
import {
  DEFAULT_MAX_TTL,
  checkCatchAll,
  checkEmailRouting,
  checkZone,
  classifyMailRecords,
  isCloudflareMxHost,
  literalRuleWarnings,
  normaliseDomain,
  planSpf,
  planSwitch,
  targetCloudflareMx,
  ttlAdvice,
  ttlProblems,
  verifyMx,
} from './lib/mail-dns.mjs';
import { DEFAULT_PROBE_TIMEOUT_MINUTES, readProbe } from './lib/probe.mjs';
import { DEFAULT_SNAPSHOT_DIR, writeResult, writeSnapshot } from './lib/snapshot.mjs';
import { Refusal, formatRecord, parseOrRefuse, positiveInt, realDeps, refuseApplyInCi, reportFailure, token } from './lib/cli.mjs';

const LABEL_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKER_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ID_RX = /^[A-Za-z0-9-]{1,64}$/;

export const SWITCH_HELP = `Usage: node scripts/standby/switch.mjs --domain <apex> --worker <email-worker-name> [options]

Points the domain's apex MX records at Cloudflare Email Routing (cmail) in one
DNS change, after checks. Dry run unless --apply. Never run --apply without
the owner's yes. Read docs/standby-switch.md first.

  --domain <apex>              The mail domain; must be a Cloudflare zone apex.
  --worker <name>              The cmail email Worker the catch-all must send to.
  --apply                      Make the change (asks you to type the domain).
  --max-ttl <seconds>          Refuse if an MX TTL is above this (default ${DEFAULT_MAX_TTL}).
  --probe-d1 <database-id>     Read the standby probe light from this D1
                               database (needs CLOUDFLARE_ACCOUNT_ID).
  --probe-timeout-minutes <n>  The probe's timeout (default ${DEFAULT_PROBE_TIMEOUT_MINUTES}).
  --skip-probe-check           Apply without a probe reading (says so loudly).
  --no-spf-change              Leave the SPF record exactly as it is.
  --cloudflare-mx <list>       host:priority,... only when Cloudflare lists none.
  --standby-label <label>      The standby subdomain label (default "standby").
  --snapshot-dir <dir>         Where snapshots go (default ./${DEFAULT_SNAPSHOT_DIR}).

Environment: CLOUDFLARE_API_TOKEN (never printed), CLOUDFLARE_ACCOUNT_ID (probe only).`;

function parse(argv) {
  const { values } = parseOrRefuse({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      domain: { type: 'string' },
      worker: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'max-ttl': { type: 'string' },
      'probe-d1': { type: 'string' },
      'probe-timeout-minutes': { type: 'string' },
      'skip-probe-check': { type: 'boolean', default: false },
      'no-spf-change': { type: 'boolean', default: false },
      'cloudflare-mx': { type: 'string' },
      'standby-label': { type: 'string' },
      'snapshot-dir': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  const domain = normaliseDomain(values.domain);
  if (!domain) throw new Refusal('--domain must be a domain name such as example.com.');
  const worker = String(values.worker ?? '').trim();
  if (!WORKER_RX.test(worker)) throw new Refusal('--worker must be the email Worker\'s name (letters, digits and hyphens).');
  const standbyLabel = String(values['standby-label'] ?? 'standby').trim().toLowerCase();
  if (!LABEL_RX.test(standbyLabel)) throw new Refusal('--standby-label must be one DNS label.');
  const probeD1 = values['probe-d1'];
  if (probeD1 !== undefined && !ID_RX.test(probeD1)) throw new Refusal('--probe-d1 must be a D1 database id.');
  return {
    help: false,
    domain,
    worker,
    apply: values.apply,
    maxTtl: values['max-ttl'] === undefined ? DEFAULT_MAX_TTL : positiveInt(values['max-ttl'], '--max-ttl', { min: 60, max: 86400 }),
    probeD1,
    probeTimeoutMinutes: values['probe-timeout-minutes'] === undefined
      ? DEFAULT_PROBE_TIMEOUT_MINUTES
      : positiveInt(values['probe-timeout-minutes'], '--probe-timeout-minutes', { min: 2, max: 60 }),
    skipProbeCheck: values['skip-probe-check'],
    noSpfChange: values['no-spf-change'],
    cloudflareMx: values['cloudflare-mx'],
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

/**
 * @param {string[]} argv
 * @param {ReturnType<typeof realDeps>} deps
 * @returns {Promise<number>} exit code: 0 done, 1 refused or failed, 2 applied but not as expected
 */
export async function runSwitch(argv, deps) {
  const { out } = deps;
  let redact = (text) => text;
  try {
    const opts = parse(argv);
    if (opts.help) {
      out(SWITCH_HELP);
      return 0;
    }
    if (opts.apply) refuseApplyInCi(deps.env);
    const client = createClient({ token: token(deps.env), fetch: deps.fetch });
    redact = client.redact;
    const now = deps.now();

    out(`cmail standby switch: ${opts.apply ? 'APPLY (will change live DNS after you confirm)' : 'DRY RUN (nothing will change)'}`);
    out(`Domain: ${opts.domain}`);

    const zoneCheck = checkZone(await client.findZones(opts.domain), opts.domain);
    if (!zoneCheck.ok) throw new Refusal(zoneCheck.error);
    const zone = zoneCheck.zone;
    out(`Zone: ${zone.id} (type ${zone.type}, ${zone.status})`);

    const problems = [];
    const warnings = [];

    const settings = await client.emailRoutingSettings(zone.id);
    out(`Email Routing: ${settings?.enabled === true ? 'enabled' : 'not enabled'}, status ${settings?.status ?? 'unknown'}`);
    const routing = checkEmailRouting(settings);
    if (!routing.ok) problems.push(routing.error);

    const mail = await readMailRecords(client, zone.id, opts.domain, opts.standbyLabel);

    let catchAll = null;
    let catchAllRead = true;
    try {
      catchAll = await client.emailRoutingCatchAll(zone.id);
    } catch (error) {
      if (!(error instanceof CloudflareError)) throw error;
      catchAllRead = false;
      problems.push(`Could not read the catch-all rule (${error.message}).`);
    }
    if (catchAllRead) {
      const check = checkCatchAll(catchAll, opts.worker);
      out(`Catch-all: ${check.ok ? `enabled, sends to Worker ${opts.worker}` : 'NOT READY'}`);
      if (!check.ok) problems.push(check.error);
    }
    try {
      warnings.push(...literalRuleWarnings(await client.emailRoutingRules(zone.id), opts.domain, opts.worker));
    } catch (error) {
      if (!(error instanceof CloudflareError)) throw error;
      warnings.push(`Could not list routing rules (${error.message}); check for literal rules by hand.`);
    }

    let required = [];
    try {
      required = await client.emailRoutingRequiredDns(zone.id);
    } catch (error) {
      if (!(error instanceof CloudflareError)) throw error;
      warnings.push(`Could not read Cloudflare's Email Routing DNS settings (${error.message}).`);
    }
    const target = targetCloudflareMx(opts.domain, required, opts.cloudflareMx);
    if (!target.ok) problems.push(target.error);

    // Probe.
    if (opts.probeD1) {
      const accountId = String(deps.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
      if (!ID_RX.test(accountId)) {
        problems.push('--probe-d1 needs CLOUDFLARE_ACCOUNT_ID in the environment.');
      } else {
        try {
          const probe = await readProbe(client, { accountId, databaseId: opts.probeD1, now: now.getTime(), timeoutMinutes: opts.probeTimeoutMinutes });
          const passed = probe.lastPassAt ? `, last pass ${new Date(probe.lastPassAt).toISOString()}` : '';
          out(`Standby probe: ${probe.light.toUpperCase()}${probe.reason ? ` (${probe.reason})` : ''}${passed}`);
          if (probe.light !== 'green') {
            problems.push(`The standby probe is ${probe.light}${probe.reason ? ` (${probe.reason})` : ''}, not green. Fix it (Admin > Standby test) and wait for a green test before switching.`);
          }
        } catch (error) {
          const message = `Could not read the standby probe (${redact(error?.message || String(error))}).`;
          if (opts.skipProbeCheck) warnings.push(`${message} Going ahead because --skip-probe-check was given.`);
          else problems.push(`${message} Fix the reading, or pass --skip-probe-check if you have checked Admin > Standby test yourself.`);
        }
      }
    } else if (opts.skipProbeCheck) {
      out('Standby probe: NOT CHECKED (--skip-probe-check). Check Admin > Standby test is green yourself.');
      warnings.push('The standby probe was not checked.');
    } else {
      out('Standby probe: not checked (no --probe-d1).');
      if (opts.apply) problems.push('Pass --probe-d1 <database-id> so the switch can confirm the probe is green, or --skip-probe-check after checking Admin > Standby test yourself.');
    }

    // Records now.
    out('');
    out('Mail records now:');
    const shown = [...mail.apexMx, ...mail.apexSpf, ...mail.dmarc, ...mail.dkim, ...mail.standbyMx];
    for (const r of shown) out(`  ${formatRecord(r)}`);
    if (!shown.length) out('  (none)');
    if (!mail.standbyMx.length) warnings.push(`No MX records on ${opts.standbyLabel}.${opts.domain}: the standby subdomain does not look set up in Email Routing.`);
    if (!mail.apexSpf.some((r) => /include:spf\.protection\.outlook\.com/i.test(r.content))) {
      warnings.push('The SPF record does not include spf.protection.outlook.com. If Exchange Online sends this domain\'s mail, check SPF covers it.');
    }

    const nonCf = mail.apexMx.filter((r) => !isCloudflareMxHost(r.content));
    const slow = ttlProblems(nonCf, opts.maxTtl);
    if (slow.length) problems.push(ttlAdvice(slow, opts.maxTtl).join('\n'));

    const spfPlan = opts.noSpfChange ? { action: 'none', note: 'SPF left as it is (--no-spf-change).' } : planSpf(mail.apexSpf);
    if (spfPlan.action === 'refuse') problems.push(spfPlan.note);

    const stamp = now.toISOString();
    const plan = target.ok ? planSwitch({ domain: opts.domain, mail, targetMx: target.mx, spfPlan, maxTtl: opts.maxTtl, stamp }) : null;
    if (plan && !plan.ok) problems.push(plan.error);

    if (plan?.ok && plan.nothingToDo) {
      out('');
      out(plan.note);
      out('Nothing to do. Use switch-back.mjs with the snapshot from before the switch to return mail to the other provider.');
      return problems.length ? reportFailure(new Refusal(problems), out, redact) : 0;
    }

    if (plan?.ok) {
      out('');
      out(`Change set (one DNS batch: Cloudflare applies all of it or none of it; Cloudflare MX from ${target.source === 'cloudflare' ? 'Cloudflare\'s Email Routing DNS settings' : '--cloudflare-mx'}):`);
      for (const r of plan.describe.deletes) out(`  - delete  ${formatRecord(r)}`);
      for (const r of plan.describe.posts) out(`  + add     ${formatRecord(r)}`);
      if (plan.describe.spf) out(`  ~ edit    TXT ${opts.domain} SPF\n      from ${plan.describe.spf.before}\n      to   ${plan.describe.spf.after}`);
      out(`  SPF: ${spfPlan.note}`);
      out('');
      out('Reverse change set (switch-back.mjs with the snapshot below):');
      for (const r of plan.describe.posts) out(`  - delete  ${formatRecord(r)}`);
      for (const r of plan.describe.deletes) out(`  + add     ${formatRecord(r)}`);
      if (plan.describe.spf) out(`  ~ edit    TXT ${opts.domain} SPF back to ${plan.describe.spf.before}`);
      out('');
      out('Left alone, so Exchange Online keeps sending: DKIM (selector CNAMEs), DMARC, the SPF terms for Exchange, autodiscover and every other record.');
    }

    if (warnings.length) {
      out('');
      out('Warnings:');
      for (const w of warnings) out(`  ! ${w}`);
    }

    // Snapshot: always when there is something to switch from, so even a
    // refused dry run leaves a record of the original MX (First-time setup uses it).
    const kind = opts.apply && !problems.length ? 'apply' : 'dry-run';
    let snapshotFile = null;
    if (nonCf.length) {
      snapshotFile = await writeSnapshot(opts.snapshotDir, {
        tool: 'switch',
        kind,
        takenAt: now,
        domain: opts.domain,
        zoneId: zone.id,
        emailRouting: { enabled: settings?.enabled === true, status: settings?.status ?? null },
        records: mail,
        plan: {
          // Recorded even when the switch is refused, so switch-back can undo
          // the same SPF edit made by hand during First-time setup.
          spf: spfPlan.action === 'edit' ? { before: spfPlan.before, after: spfPlan.after } : null,
          cloudflareMx: target.ok ? target.mx : [],
        },
      });
      out('');
      out(`Snapshot saved (keep it private, not in git): ${snapshotFile}`);
    }

    if (problems.length) throw new Refusal(problems);
    if (!opts.apply) {
      out('');
      out('Dry run only. To apply, the owner says yes, then a person runs this again with --apply.');
      return 0;
    }

    // Apply.
    out('');
    out(`About to change the live MX records of ${opts.domain}. Mail will start arriving in cmail.`);
    const answer = await deps.prompt(`Type the domain name (${opts.domain}) to go ahead, anything else to stop: `);
    if (String(answer ?? '').trim().toLowerCase() !== opts.domain) throw new Refusal('The confirmation did not match.');

    // Nothing may have changed while we waited for the person.
    const fresh = await readMailRecords(client, zone.id, opts.domain, opts.standbyLabel);
    if (JSON.stringify(fresh.apexMx) !== JSON.stringify(mail.apexMx) || JSON.stringify(fresh.apexSpf) !== JSON.stringify(mail.apexSpf)) {
      throw new Refusal('The MX or SPF records changed since they were read. Run the dry run again.');
    }

    await client.batchRecords(zone.id, plan.batch);
    out('Applied the DNS batch.');

    const after = await readMailRecords(client, zone.id, opts.domain, opts.standbyLabel);
    const mxCheck = verifyMx(after, target.mx);
    const spfOk = !plan.describe.spf || (after.apexSpf.length === 1 && after.apexSpf[0].content === plan.describe.spf.after);
    await writeResult(snapshotFile, {
      appliedAt: deps.now().toISOString(),
      verified: mxCheck.ok && spfOk,
      apexMx: after.apexMx,
      apexSpf: after.apexSpf,
    });
    out('');
    out('Mail records after:');
    for (const r of [...after.apexMx, ...after.apexSpf]) out(`  ${formatRecord(r)}`);
    if (!mxCheck.ok || !spfOk) {
      out('');
      out('WARNING: the records are not exactly as planned. Check them in the dashboard now.');
      if (mxCheck.missing.length) out(`  missing MX: ${mxCheck.missing.join(', ')}`);
      if (mxCheck.extra.length) out(`  unexpected MX: ${mxCheck.extra.join(', ')}`);
      if (!spfOk) out('  SPF is not what was planned.');
      out(`  To undo: node scripts/standby/switch-back.mjs --domain ${opts.domain} --snapshot "${snapshotFile}"`);
      return 2;
    }
    out('');
    out('Done. Next: verify mail is arriving (docs/standby-switch.md, "Verify").');
    out(`To switch back: node scripts/standby/switch-back.mjs --domain ${opts.domain} --snapshot "${snapshotFile}"`);
    return 0;
  } catch (error) {
    return reportFailure(error, out, redact);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runSwitch(process.argv.slice(2), realDeps());
}
