// The PowerShell collector against the Worker's contract: runs the mocked
// harness (container/m365-perms/collect.Tests.ps1) when pwsh is installed and
// checks its snapshot with the same validator the Worker uses. Also checks,
// statically, that the script can only run read-only Exchange commands.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSnapshot } from './snapshot';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../container/m365-perms');
const SCRIPT = readFileSync(join(DIR, 'collect.ps1'), 'utf8');
// pwsh start-up alone can take several seconds on CI runners, far past
// vitest's 5-second default. The harness process gets HARNESS_TIMEOUT_MS and
// the test HARNESS_TEST_TIMEOUT_MS, so a slow run fails on the process limit
// (with its output) before vitest gives up.
const HARNESS_TIMEOUT_MS = 60_000;
const HARNESS_TEST_TIMEOUT_MS = HARNESS_TIMEOUT_MS + 30_000;
// collect.ps1 needs PowerShell 7.6 or later (#Requires). CI also runs the
// harness in its own job with PowerShell 7.6.10 installed (ci.yml), so it is
// never silently skipped there.
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '"$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)"'], { encoding: 'utf8', timeout: 30_000 });
const [major, minor] = (pwsh.status === 0 ? pwsh.stdout.trim() : '0.0').split('.').map(Number);
const hasPwsh = major > 7 || (major === 7 && minor >= 6);
if (!hasPwsh) console.warn('collect.ps1 harness skipped here: PowerShell 7.6 or later is not installed (the CI collector job runs it)');

describe('collect.ps1 is read-only', () => {
  it('allow-lists only Get-*, Connect- and Disconnect- commands', () => {
    const block = /\$script:AllowedCommands = @\(([\s\S]*?)\)/.exec(SCRIPT)?.[1] ?? '';
    const names = [...block.matchAll(/'([A-Za-z-]+)'/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^(Get|Connect|Disconnect)-/);
  });

  it('never names an Exchange write cmdlet', () => {
    expect(SCRIPT).not.toMatch(/\b(Add|Set|New|Remove|Enable|Disable|Update|Grant|Revoke)-(EXO)?(Mailbox|Recipient|RoleGroup|ManagementRole|DistributionGroup|ServicePrincipal|User|Group)\w*/i);
  });

  it('calls Exchange only through Invoke-Exo', () => {
    const direct = SCRIPT.split('\n').filter((line) => /^\s*(?!#).*\b(Get-EXO\w+|Connect-ExchangeOnline|Disconnect-ExchangeOnline)\b/.test(line)
      && !/Invoke-Exo|AllowedCommands|^\s*'|^\s*#|SYNOPSIS|\.DESCRIPTION/.test(line));
    expect(direct).toEqual([]);
  });

  it('pins exact versions in the Dockerfile', () => {
    const dockerfile = readFileSync(join(DIR, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^ARG POWERSHELL_VERSION=\d+\.\d+\.\d+-1\.deb$/m);
    expect(dockerfile).toMatch(/^ARG EXO_MODULE_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toMatch(/-RequiredVersion '\$\{EXO_MODULE_VERSION\}'/);
  });
});

describe.skipIf(!hasPwsh)('collect.ps1 harness (mocked cmdlets)', () => {
  it('passes its checks and writes a snapshot the Worker accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmail-perms-'));
    try {
      const out = join(dir, 'snapshot.json');
      const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(DIR, 'collect.Tests.ps1'), '-OutFile', out], { encoding: 'utf8', timeout: HARNESS_TIMEOUT_MS });
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      const text = readFileSync(out, 'utf8');
      const parsed = parseSnapshot(text, {
        tenantId: '00000000-0000-0000-0000-000000000000',
        organization: 'example.onmicrosoft.com',
        now: Date.now(),
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.snapshot.mailboxes).toHaveLength(4);
        expect(parsed.snapshot.mailboxes.find((mailbox) => mailbox.address === 'legal@example.test')).toMatchObject({ complete: false, grants: [] });
        expect(parsed.snapshot.mailboxes.find((mailbox) => mailbox.address === 'support@example.test')?.complete).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, HARNESS_TEST_TIMEOUT_MS);
});
