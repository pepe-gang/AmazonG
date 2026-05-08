import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../../src/main/atomicJson.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'amazong-atomic-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('writes JSON to a fresh path', async () => {
    const path = join(tmpRoot, 'data.json');
    await writeJsonAtomic(path, { hello: 'world' });
    const contents = await readFile(path, 'utf8');
    expect(JSON.parse(contents)).toEqual({ hello: 'world' });
  });

  it('overwrites an existing file in place', async () => {
    const path = join(tmpRoot, 'data.json');
    await writeFile(path, JSON.stringify({ old: true }), 'utf8');
    await writeJsonAtomic(path, { fresh: true });
    const contents = await readFile(path, 'utf8');
    expect(JSON.parse(contents)).toEqual({ fresh: true });
  });

  it('creates parent directories on demand', async () => {
    const path = join(tmpRoot, 'nested', 'deep', 'data.json');
    await writeJsonAtomic(path, { ok: 1 });
    const contents = await readFile(path, 'utf8');
    expect(JSON.parse(contents)).toEqual({ ok: 1 });
  });

  it('formats with 2-space indent so diffs stay readable', async () => {
    const path = join(tmpRoot, 'data.json');
    await writeJsonAtomic(path, { a: 1, b: [2, 3] });
    const contents = await readFile(path, 'utf8');
    expect(contents).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it('does not leave temp files in the directory after a successful write', async () => {
    const path = join(tmpRoot, 'data.json');
    await writeJsonAtomic(path, { ok: 1 });
    const entries = await readdir(tmpRoot);
    expect(entries).toEqual(['data.json']);
  });

  it('survives concurrent writers without producing a corrupt or partial file', async () => {
    const path = join(tmpRoot, 'data.json');
    // 8 concurrent writers all racing; the last rename wins, but no
    // reader should ever see a half-written JSON document.
    const writes = Array.from({ length: 8 }, (_, i) =>
      writeJsonAtomic(path, { writer: i }),
    );
    await Promise.all(writes);
    const contents = await readFile(path, 'utf8');
    const parsed = JSON.parse(contents) as { writer: number };
    expect(typeof parsed.writer).toBe('number');
    expect(parsed.writer).toBeGreaterThanOrEqual(0);
    expect(parsed.writer).toBeLessThan(8);
    // No straggler temp files left behind.
    const entries = await readdir(tmpRoot);
    expect(entries).toEqual(['data.json']);
  });

  it('throws when the directory is not writable but does not corrupt the destination', async () => {
    const path = join(tmpRoot, 'data.json');
    await writeJsonAtomic(path, { ok: 1 });
    // Object with a circular reference makes JSON.stringify throw,
    // simulating a write-time failure between mkdir and rename.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(writeJsonAtomic(path, circular)).rejects.toThrow();
    // Original content untouched.
    const contents = await readFile(path, 'utf8');
    expect(JSON.parse(contents)).toEqual({ ok: 1 });
    // No temp file left behind for the failed write.
    const entries = await readdir(tmpRoot);
    expect(entries).toEqual(['data.json']);
  });
});
