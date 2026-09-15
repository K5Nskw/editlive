import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnergy } from './analyze.ts';
import { outputSize } from './render.ts';

const SILENT = -70;

/** A steady level is its own baseline, so nothing should stand out. */
test('buildEnergy flattens a recording with no dynamics', () => {
  const loudness = new Array<number>(60).fill(-24);
  const motion = new Array<number>(60).fill(0.02);
  for (const value of buildEnergy(loudness, motion, true)) {
    assert.ok(value <= 0.01, `expected a flat curve, got ${value}`);
  }
});

test('buildEnergy lifts the loud stretch above the quiet one', () => {
  const loudness = new Array<number>(60).fill(-45);
  const motion = new Array<number>(60).fill(0.02);
  for (let i = 20; i < 30; i++) loudness[i] = -14;

  const energy = buildEnergy(loudness, motion, true);
  assert.ok(energy[25]! > 0.6, `loud section scored ${energy[25]}`);
  assert.ok(energy[5]! < 0.1, `quiet section scored ${energy[5]}`);
});

/** Two feeds 20 dB apart should produce the same shape, not the same level. */
test('buildEnergy is relative to the recording, not to an absolute level', () => {
  const quietFeed = new Array<number>(40).fill(-50);
  const loudFeed = new Array<number>(40).fill(-30);
  for (let i = 10; i < 20; i++) {
    quietFeed[i] = -38;
    loudFeed[i] = -18;
  }
  const motion = new Array<number>(40).fill(0.05);

  const a = buildEnergy(quietFeed, motion, true);
  const b = buildEnergy(loudFeed, motion, true);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]! - b[i]!) < 0.001, `index ${i}: ${a[i]} vs ${b[i]}`);
  }
});

test('buildEnergy falls back to motion when the recording has no audio', () => {
  const loudness = new Array<number>(30).fill(SILENT);
  const motion = new Array<number>(30).fill(0.01);
  for (let i = 12; i < 18; i++) motion[i] = 0.6;

  const energy = buildEnergy(loudness, motion, false);
  assert.ok(energy[15]! > 0.9, `motion peak scored ${energy[15]}`);
  assert.equal(energy[0], 0);
});

test('buildEnergy stays within 0..1', () => {
  const loudness = Array.from({ length: 50 }, (_, i) => (i % 7 === 0 ? -6 : -60));
  const motion = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? 0.9 : 0));
  for (const value of buildEnergy(loudness, motion, true)) {
    assert.ok(value >= 0 && value <= 1, `out of range: ${value}`);
  }
});

test('outputSize keeps the requested aspect on an even pixel grid', () => {
  assert.deepEqual(outputSize('9:16', 1080), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize('16:9', 1080), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize('1:1', 720), { width: 720, height: 720 });
  assert.deepEqual(outputSize('4:5', 1080), { width: 1080, height: 1350 });
  for (const aspect of ['9:16', '16:9', '1:1', '4:5'] as const) {
    const { width, height } = outputSize(aspect, 721);
    assert.equal(width % 2, 0);
    assert.equal(height % 2, 0);
  }
});
