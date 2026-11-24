import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Review C12: every route that changes state (a form action, or a POST/PUT/PATCH/DELETE handler)
// sits behind the CSRF guard in hooks.server.ts (see hooks.csrf.test.ts). This list is a tripwire:
// adding a state-changing route makes this test fail until you add it here on purpose, which is the
// moment to check it is covered by the guard (cross-origin form posts and non-form requests) and, if it
// is meant to be called without a cookie, that it is listed in the guard's exemptions.

const ROUTES = join(__dirname, 'routes');
const MUTATING = /export\s+(?:async\s+)?(?:const|function)\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+actions\b/;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/^\+(page|layout)?\.?server\.ts$/.test(name) || name === '+server.ts') out.push(full);
  }
  return out;
}

describe('state-changing routes (CSRF tripwire)', () => {
  it('matches the reviewed list', () => {
    const found = walk(ROUTES, [])
      .filter((file) => MUTATING.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROUTES, file).split(sep).join('/'))
      .sort();
    expect(found).toMatchInlineSnapshot(`
      [
        "admin/copy-back/+page.server.ts",
        "admin/mailboxes/+page.server.ts",
        "admin/microsoft-365/+page.server.ts",
        "admin/orgchart/+page.server.ts",
        "admin/passkeys/+page.server.ts",
        "admin/policy/+page.server.ts",
        "admin/quarantine/+page.server.ts",
        "admin/settings/+page.server.ts",
        "admin/signatures/+page.server.ts",
        "admin/standby/+page.server.ts",
        "admin/travel/+page.server.ts",
        "admin/users/+page.server.ts",
        "api/messages/[id]/+server.ts",
        "api/messages/bulk/+server.ts",
        "api/messages/focus/+server.ts",
        "api/passkeys/register/options/+server.ts",
        "api/passkeys/register/verify/+server.ts",
        "api/push/subscriptions/+server.ts",
        "auth/email/+page.server.ts",
        "auth/logout/+server.ts",
        "auth/passkey/options/+server.ts",
        "auth/passkey/pair/join/+server.ts",
        "auth/passkey/pair/options/+server.ts",
        "auth/passkey/pair/verify/+server.ts",
        "auth/passkey/verify/+server.ts",
        "bootstrap/+page.server.ts",
        "enroll/[provider]/+page.server.ts",
        "mail/[id]/+page.server.ts",
        "mail/calendar/+page.server.ts",
        "mail/calendar/new/+page.server.ts",
        "mail/compose/+page.server.ts",
        "mail/connected-apps/+page.server.ts",
        "mail/passkeys/+page.server.ts",
        "mail/passkeys/pair/+server.ts",
        "mail/rules/+page.server.ts",
        "mail/rules/edit/+page.server.ts",
        "mail/settings/+page.server.ts",
        "mcp/+server.ts",
        "oauth/authorize/+page.server.ts",
        "oauth/register/+server.ts",
        "oauth/revoke/+server.ts",
        "oauth/token/+server.ts",
        "policy/+page.server.ts",
      ]
    `);
  });
});
