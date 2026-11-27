import { describe, expect, it, vi } from 'vitest';

import worker from './index';

type Point = { indexes?: string[]; blobs?: string[]; doubles?: number[] };

function datasetFor(points: Point[]) {
  return { writeDataPoint: (p: Point) => { points.push(p); } };
}

function message(from: string, to: string, rawSize = 321) {
  const setReject = vi.fn();
  return { value: { from, to, rawSize, headers: new Headers(), raw: new Blob(['x']).stream(), setReject, forward: vi.fn(), reply: vi.fn() }, setReject };
}

async function receive(value: unknown, env: Record<string, unknown>) {
  const handler = worker as unknown as { email(m: unknown, e: Record<string, unknown>, c: { waitUntil(p: Promise<unknown>): void }): Promise<void> };
  await handler.email(value, env, { waitUntil: vi.fn() });
}

describe('inbound usage events', () => {
  it('counts a rejected message by a fixed code, with no address in the point', async () => {
    const points: Point[] = [];
    const m = message('not an address', 'mailbox@example.test');
    await receive(m.value, { USAGE: datasetFor(points) });

    expect(m.setReject).toHaveBeenCalledWith('Invalid envelope address');
    expect(points).toHaveLength(1);
    expect(points[0].blobs).toEqual(['mail.inbound', 'invalid_address', '5xx']);
    expect(points[0].doubles?.slice(1)).toEqual([321, 1]);
    const everything = JSON.stringify(points);
    expect(everything).not.toContain('example.test');
    expect(everything).not.toContain('not an address');
  });

  it('works unchanged with no usage binding', async () => {
    const m = message('not an address', 'mailbox@example.test');
    await receive(m.value, {});
    expect(m.setReject).toHaveBeenCalledWith('Invalid envelope address');
  });

  it('counts an error once as error and rethrows it unchanged', async () => {
    const points: Point[] = [];
    const m = message('sender@example.test', 'mailbox@example.test');
    const boom = new Error('database down');
    const DB = { prepare: () => { throw boom; } };
    await expect(receive(m.value, { USAGE: datasetFor(points), DB, STORAGE: {} })).rejects.toBe(boom);
    expect(points).toHaveLength(1);
    expect(points[0].blobs).toEqual(['mail.inbound', 'error', '5xx']);
  });

  it('a throwing dataset never breaks delivery', async () => {
    const m = message('not an address', 'mailbox@example.test');
    const USAGE = { writeDataPoint: () => { throw new Error('dataset down'); } };
    await expect(receive(m.value, { USAGE })).resolves.toBeUndefined();
    expect(m.setReject).toHaveBeenCalledOnce();
  });
});
