import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reversePatch } from './reverse-diff.js';

test('reverses +/- lines and swaps the hunk header ranges', () => {
  // A fix that replaced a buggy line with a guarded one.
  const fixPatch = [
    '@@ -10,3 +10,3 @@ function get(user) {',
    ' function get(user) {',
    '-  return user.profile.name;',
    '+  return user?.profile?.name ?? "";',
    ' }',
  ].join('\n');

  const { patch, ranges } = reversePatch(fixPatch);
  const lines = patch.split('\n');
  assert.equal(lines[0], '@@ -10,3 +10,3 @@'); // ranges swapped, heading dropped
  // The buggy line is now ADDED (this "PR introduces the bug"):
  assert.ok(patch.includes('+  return user.profile.name;'));
  // The fixed line is now REMOVED:
  assert.ok(patch.includes('-  return user?.profile?.name ?? "";'));
  // context untouched
  assert.ok(patch.includes(' function get(user) {'));
  // ground-truth target = the fix's OLD-side region (lines 10..12 in the buggy file)
  assert.deepEqual(ranges, [{ start: 10, count: 3 }]);
});

test('handles single-line hunk headers (implicit count of 1) and pure additions', () => {
  // Fix that ADDED a missing null check (old side had 0 lines at that point).
  const fixPatch = ['@@ -5,0 +6,1 @@', '+  if (!ptr) return;'].join('\n');
  const { patch, ranges } = reversePatch(fixPatch);
  assert.equal(patch.split('\n')[0], '@@ -6,1 +5,0 @@');
  assert.ok(patch.includes('-  if (!ptr) return;')); // reversed → removal
  assert.deepEqual(ranges, [{ start: 5, count: 0 }]);
});

test('reversing twice returns the original body (round-trip)', () => {
  const original = ['@@ -1,4 +1,4 @@', ' a', '-b', '+B', ' c', ' d'].join('\n');
  const once = reversePatch(original).patch;
  const twice = reversePatch(once).patch;
  assert.equal(twice, original);
});

test('multiple hunks each get their own ground-truth range', () => {
  const fixPatch = [
    '@@ -3,2 +3,2 @@',
    '-bad1',
    '+good1',
    ' ctx',
    '@@ -40,1 +40,2 @@',
    ' keep',
    '+good2',
  ].join('\n');
  const { ranges } = reversePatch(fixPatch);
  assert.deepEqual(ranges, [
    { start: 3, count: 2 },
    { start: 40, count: 1 },
  ]);
});
