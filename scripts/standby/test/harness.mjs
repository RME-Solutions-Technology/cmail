import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSwitch } from '../switch.mjs';
import { runSwitchBack } from '../switch-back.mjs';
import { ACCOUNT_ID, MockCloudflare, TEST_TOKEN, preparedState } from './mock-cloudflare.mjs';

export async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cmail-standby-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function snapshotFiles(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * Runs a tool against a mock. `answer` is what the person types; `prompted`
 * records whether the confirmation was asked at all.
 */
export async function run(tool, argv, { mock, env = {}, answer, clock } = {}) {
  const lines = [];
  const state = { prompted: false };
  const deps = {
    env: { CLOUDFLARE_API_TOKEN: TEST_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, ...env },
    fetch: mock.fetch,
    now: () => new Date(clock ?? mock.now),
    out: (line) => lines.push(...String(line).split('\n')),
    sleep: async () => {},
    prompt: async () => {
      state.prompted = true;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const code = tool === 'switch' ? await runSwitch(argv, deps) : await runSwitchBack(argv, deps);
  return { code, lines, text: lines.join('\n'), prompted: state.prompted };
}

/** A mock zone in the prepared state, after `mutate(state)` adjusts it. */
export function newMock(mutate) {
  const state = preparedState();
  if (mutate) mutate(state);
  return new MockCloudflare(state);
}
