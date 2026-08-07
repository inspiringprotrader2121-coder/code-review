import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRiskSignals, isHighRiskDiff, riskProbeFocus } from './risk.js';

test('isHighRiskDiff: risk path alone is enough', () => {
  assert.equal(
    isHighRiskDiff([{ filename: 'apps/server/src/routes/billing.ts', patch: '@@\n+console.log("hi")\n' }]),
    true,
  );
  assert.equal(
    isHighRiskDiff([{ filename: 'packages/store/src/auth/session.ts', patch: null }]),
    true,
  );
});

test('isHighRiskDiff: ordinary UI copy alone does not trigger', () => {
  assert.equal(
    isHighRiskDiff([
      {
        filename: 'apps/web/src/components/Welcome.tsx',
        patch: '@@\n+<p>Welcome to the dashboard</p>\n',
      },
    ]),
    false,
  );
});

test('isHighRiskDiff: two independent risk signals in hunk text trigger', () => {
  assert.equal(
    isHighRiskDiff([
      {
        filename: 'apps/api/src/handlers/users.ts',
        patch:
          '@@\n+await Promise.all(items.map(expire))\n+if (pagination.offset + limit < hardCeiling) emitContinuation()\n',
      },
    ]),
    true,
  );
});

test('isHighRiskDiff: a single weak token in a non-risk path does not trigger', () => {
  assert.equal(
    isHighRiskDiff([
      {
        filename: 'apps/web/src/components/Welcome.tsx',
        patch: '@@\n+const token = "demo"\n',
      },
    ]),
    false,
  );
});

test('isHighRiskDiff: removed files are ignored', () => {
  assert.equal(
    isHighRiskDiff([
      {
        filename: 'apps/server/src/routes/auth.ts',
        status: 'removed',
        patch: '@@\n-checkSession()\n',
      },
    ]),
    false,
  );
});

// Each case below is a defect Greptile v5 reported on PRs #231-250 and Orvex
// either missed or filed at the wrong severity. The probe that would have hunted
// it must be selectable from the diff alone.

test('detectRiskSignals: an outage fallback around auth routing raises the auth probe', () => {
  const signals = detectRiskSignals([
    {
      filename: 'frontend/src/App.jsx',
      patch:
        '@@\n+  if (sessionError) return <OutageScreen />;\n'
        + '+  return <AdminIndexRedirect />;\n',
    },
  ]);
  assert.equal(signals[0]?.id, 'degraded-auth');
});

test('detectRiskSignals: a concurrent expiry batch raises the partial-batch probe', () => {
  const signals = detectRiskSignals([
    {
      filename: 'backend/src/services/subscription.js',
      patch: '@@\n+  await Promise.all(due.map((row) => markExpired(row)));\n+  await cleanupExpired();\n',
    },
  ]);
  assert.ok(signals.some((s) => s.id === 'partial-batch'));
});

test('detectRiskSignals: an already-redeemed short-circuit raises the retry probe', () => {
  const signals = detectRiskSignals([
    {
      filename: 'backend/src/services/coupon.js',
      patch: '@@\n+  if (completed?.count === 0) { return; }\n+  await incrementUsedCountIfAllowed(id);\n',
    },
  ]);
  assert.ok(signals.some((s) => s.id === 'retry-lost-write'));
});

test('detectRiskSignals: a continuation offset raises the truncation probe', () => {
  const signals = detectRiskSignals([
    {
      filename: 'backend/src/routes/gdpr.js',
      patch: '@@\n+  const next = offset + GDPR_EXPORT_PAGE_SIZE;\n+  return { rows, continuation: next };\n',
    },
  ]);
  assert.ok(signals.some((s) => s.id === 'pagination-ceiling'));
});

test('detectRiskSignals: a username-keyed index raises the tenant-keying probe', () => {
  const signals = detectRiskSignals([
    {
      filename: 'backend/src/services/line.js',
      patch: '@@\n+  await redis.set(`username:${username}`, panelSlug);\n',
    },
  ]);
  assert.ok(signals.some((s) => s.id === 'tenant-keying'));
});

test('detectRiskSignals: deletions alone never raise a hypothesis', () => {
  assert.deepEqual(
    detectRiskSignals([
      {
        filename: 'backend/src/services/coupon.js',
        patch: '@@\n-  await Promise.all(rows.map(expire));\n',
      },
    ]),
    [],
  );
});

test('detectRiskSignals: ordinary UI copy raises nothing', () => {
  assert.deepEqual(
    detectRiskSignals([
      { filename: 'apps/web/src/components/Welcome.tsx', patch: '@@\n+<p>Welcome to the dashboard</p>\n' },
    ]),
    [],
  );
});

test('riskProbeFocus names the hypothesis and demands a concrete failure path', () => {
  const [signal] = detectRiskSignals([
    {
      filename: 'backend/src/services/subscription.js',
      patch: '@@\n+  await Promise.all(due.map((row) => markExpired(row)));\n',
    },
  ]);
  const focus = riskProbeFocus(signal);
  assert.match(focus, /Single-hypothesis probe/);
  assert.match(focus, /backend\/src\/services\/subscription\.js/);
  assert.match(focus, /concrete failure path/);
  assert.match(focus, /a clean kill is a successful probe/);
});

test('detectRiskSignals: a keyword present in every changed file loses to a selective one', () => {
  // PR #240 shape: a broad rule fired everywhere while the hypothesis that
  // pointed at the real defect fired in one place and was ranked below it.
  const everywhere = 'const endpoint = buildPath(); // GET\n';
  const signals = detectRiskSignals([
    { filename: 'a/routes/one.js', patch: `@@\n+${everywhere}` },
    { filename: 'a/routes/two.js', patch: `@@\n+${everywhere}` },
    {
      filename: 'a/routes/gdpr.js',
      patch: `@@\n+${everywhere}+  const next = offset + PAGE_SIZE;\n+  return { rows, continuation: next };\n`,
    },
  ]);
  assert.equal(signals[0]?.id, 'pagination-ceiling');
});

test('detectRiskSignals: broad rules no longer fire on ordinary backend code', () => {
  const ids = detectRiskSignals([
    {
      filename: 'backend/src/services/report.js',
      patch: '@@\n+  const active = rows.filter((r) => r.state === "on");\n+  router.get("/x", handler);\n',
    },
  ]).map((s) => s.id);
  assert.equal(ids.includes('schedule-window'), false);
  assert.equal(ids.includes('contract-drift'), false);
});

test('detectRiskSignals: an availability helper on authorize raises the schedule probe', () => {
  // PR #247 shape: only `buildAvailabilityWhere` was added to authorizeLiveStream.
  // Without matching that helper name, the probe never ran and Greptile's
  // playback-vs-listings finding went unmatched.
  const signals = detectRiskSignals([
    {
      filename: 'backend/src/routes/stream-play.js',
      patch:
        '@@\n+       ${buildAvailabilityWhere(\'s\')}\n'
        + '+router.__test = { authorizeLiveStream };\n',
    },
  ]);
  assert.equal(signals[0]?.id, 'schedule-window');
});

test('detectRiskSignals: an unfiltered storage listener raises the event-fanout probe', () => {
  // PR #233 shape: CookieConsent listened to every storage event.
  const signals = detectRiskSignals([
    {
      filename: 'frontend/src/components/marketing/CookieConsent.jsx',
      patch:
        '@@\n+    const onStorage = () => { invalidateConsentCache(); check(); };\n'
        + '+    window.addEventListener(\'storage\', onStorage);\n',
    },
  ]);
  assert.equal(signals[0]?.id, 'event-fanout');
});
