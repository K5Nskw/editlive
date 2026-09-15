import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectHighlights, type AnalysisResult } from './analyze.ts';
import { outputSize } from './render.ts';

function makeAnalysis(energy: number[], scenes: number[] = []): AnalysisResult {
  return {
    duration: energy.length,
    interval: 1,
    energy,
    loudness: energy.map((v) => -60 + v * 40),
    motion: energy.map((v) => v * 0.5),
    scenes,
    hasAudio: true,
    generatedAt: Date.now(),
  };
}

/** A flat curve with two bursts should yield exactly those two moments. */
test('detectHighlights finds the loud bursts and nothing else', () => {
  const energy = new Array<number>(300).fill(0.05);
  for (let i = 60; i < 75; i++) energy[i] = 0.9;
  for (let i = 200; i < 212; i++) energy[i] = 0.8;

  const highlights = detectHighlights(makeAnalysis(energy), { sensitivity: 0.5 });

  assert.equal(highlights.length, 2);
  const [first, second] = [...highlights].sort((a, b) => a.start - b.start);
  assert.ok(first!.start < 60 && first!.end > 70, `first window ${first!.start}-${first!.end}`);
  assert.ok(second!.start < 200 && second!.end > 210, `second window ${second!.start}-${second!.end}`);
});

test('detectHighlights returns nothing for a flat curve', () => {
  assert.deepEqual(detectHighlights(makeAnalysis(new Array<number>(200).fill(0.4))), []);
});

test('detectHighlights keeps every window inside the recording', () => {
  const energy = new Array<number>(40).fill(0.05);
  for (let i = 0; i < 4; i++) energy[i] = 1;
  for (let i = 36; i < 40; i++) energy[i] = 0.95;

  for (const hl of detectHighlights(makeAnalysis(energy), { sensitivity: 0.9 })) {
    assert.ok(hl.start >= 0, `start ${hl.start}`);
    assert.ok(hl.end <= 40, `end ${hl.end}`);
    assert.ok(hl.end > hl.start);
  }
});

test('detectHighlights honours the clip length bounds', () => {
  const energy = new Array<number>(400).fill(0.05);
  for (let i = 100; i < 300; i++) energy[i] = 0.9;

  for (const hl of detectHighlights(makeAnalysis(energy), { minClipSeconds: 10, maxClipSeconds: 30 })) {
    const length = hl.end - hl.start;
    assert.ok(length >= 9.9 && length <= 30.1, `length ${length}`);
  }
});

test('a higher sensitivity never returns fewer candidates', () => {
  const energy = new Array<number>(600).fill(0.1);
  for (const peak of [50, 150, 250, 350, 450]) {
    for (let i = peak; i < peak + 8; i++) energy[i] = 0.3 + (peak % 200) / 400;
  }
  const analysis = makeAnalysis(energy);
  assert.ok(detectHighlights(analysis, { sensitivity: 1 }).length >= detectHighlights(analysis, { sensitivity: 0 }).length);
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
