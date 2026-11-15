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

/** Default dependencies; the tests replace every one of them. */
export function realDeps() {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    now: () => new Date(),
    out: (line) => process.stdout.write(`${line}\n`),
    prompt: askOnTerminal,
  };
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

/** Prints a CloudflareError or Refusal and returns the exit code. */
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
