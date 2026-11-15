// Shared command-line plumbing for switch.mjs and switch-back.mjs.

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CloudflareError } from './cloudflare.mjs';
import { effectiveTtl } from './mail-dns.mjs';

export class Refusal extends Error {
  constructor(lines) {
    super(Array.isArray(lines) ? lines.join('\n') : String(lines));
    this.name = 'Refusal';
  }
}

/**
 * Exit codes, the same for both scripts (docs/standby-switch.md, "Exit codes").
 * 1 always means nothing was changed.
 */
export const EXIT = Object.freeze({
  DONE: 0,
  NOTHING_CHANGED: 1,
  NOT_AS_PLANNED: 2,
  UNKNOWN: 3,
  UNLOCKED_ONLY: 4,
});

/** Default dependencies; the tests replace every one of them. */
export function realDeps() {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    now: () => new Date(),
    out: (line) => process.stdout.write(`${line}\n`),
    prompt: askOnTerminal,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

/** Re-reads after a write, retrying a few times; returns null if every try failed. */
export async function rereadWithRetry(read, deps, { attempts = 4, delayMs = 5000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      deps.out(`  re-read ${attempt} of ${attempts} failed (${error instanceof CloudflareError ? error.message : 'error'})`);
      if (attempt < attempts) await deps.sleep(delayMs);
    }
  }
  return null;
}

/** A write whose outcome is unknown must never be reported as "nothing changed". */
export function isDefiniteRefusal(error) {
  return error instanceof CloudflareError && error.definite;
}

/** Typed confirmation. Only an interactive terminal counts: piped input is refused. */
export async function askOnTerminal(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Refusal('--apply needs a person at an interactive terminal to type the confirmation. Nothing was changed.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export function refuseApplyInCi(env) {
  if (env.CI && env.CI !== 'false' && env.CI !== '0') {
    throw new Refusal('--apply is refused when CI is set: DNS changes are run by a person, never by automation. Nothing was changed.');
  }
}

export function token(env) {
  const value = env.CLOUDFLARE_API_TOKEN;
  if (!value || !value.trim()) {
    throw new Refusal('Set CLOUDFLARE_API_TOKEN in the environment (not on the command line). See docs/standby-switch.md for the permissions it needs.');
  }
  return value;
}

export function formatRecord(r) {
  const ttl = r.ttl === 1 ? 'Auto (300s)' : `${effectiveTtl(r.ttl)}s`;
  if (r.type === 'MX') return `MX  ${r.name}  ${r.priority} ${r.content}  ttl ${ttl}`;
  return `${r.type}  ${r.name}  ${r.content}  ttl ${ttl}`;
}

/** node:util parseArgs, with its usage errors turned into a plain refusal. */
export function parseOrRefuse(config) {
  try {
    return parseArgs(config);
  } catch (error) {
    if (String(error?.code ?? '').startsWith('ERR_PARSE_ARGS')) throw new Refusal(`${error.message} (use --help)`);
    throw error;
  }
}

/** For an unexpected error after a write was sent: the state is unknown, exit 3. */
export function reportUnknownAfterWrite(error, out, redact, command) {
  out('');
  out(`OUTCOME UNKNOWN: an error after the DNS change was sent (${redact(error?.message || String(error))}).`);
  out('Check DNS > Records in the dashboard now.');
  if (command) out(`To undo or finish (safe whatever the state; run without --apply first): ${command}`);
  return EXIT.UNKNOWN;
}

/** For failures before any write: prints the error and returns 1 (nothing changed). */
export function reportFailure(error, out, redact = (text) => text) {
  if (error instanceof Refusal) {
    out('');
    out('REFUSED. Nothing was changed.');
    for (const line of error.message.split('\n')) out(`  ${redact(line)}`);
    return 1;
  }
  if (error instanceof CloudflareError) {
    out('');
    out(`STOPPED: ${redact(error.message)}`);
    return 1;
  }
  out('');
  out(`STOPPED: unexpected error: ${redact(error?.message || String(error))}`);
  return 1;
}

export function positiveInt(value, name, { min, max }) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value ?? '')) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Refusal(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}
