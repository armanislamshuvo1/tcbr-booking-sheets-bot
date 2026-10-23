const assert = require('assert');
const {
  isRebookedOrHistoricalRemark,
  isPostponedText,
  isCancelledText,
  isChangedText,
  isSpecialRemarkText
} = require('../src/detector');

console.log('🧪 Running Remark Classification Test Suite...\n');

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ── Test Cases: Active Rebooked / Historical Postponements ───────────────────

it('Row 1321: "Postpone from Sept" is an active booking (not postponed)', () => {
  const text = 'Postpone from Sept';
  assert.strictEqual(isRebookedOrHistoricalRemark(text), true, 'Should be recognized as rebooked/historical');
  assert.strictEqual(isPostponedText(text), false, 'Should NOT be considered postponed');
  assert.strictEqual(isSpecialRemarkText(text), false, 'Should NOT be excluded by isSpecialRemarkText');
});

it('Row 1326: "Early Bird Prom 2026 / Changed from Sept to Oct" is active', () => {
  const text = 'Early Bird Prom 2026 / Changed from Sept to Oct';
  assert.strictEqual(isRebookedOrHistoricalRemark(text), true, 'Should be recognized as rebooked/historical');
  assert.strictEqual(isPostponedText(text), false, 'Should NOT be considered postponed');
  assert.strictEqual(isChangedText(text), false, 'Should NOT be considered changed-out');
  assert.strictEqual(isSpecialRemarkText(text), false, 'Should NOT be excluded');
});

it('"Postpone from last year " is active', () => {
  const text = 'Postpone from last year ';
  assert.strictEqual(isPostponedText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"Change from Code C June" is active', () => {
  const text = 'Change from Code C June';
  assert.strictEqual(isChangedText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"Postpone from J3 May" is active', () => {
  const text = 'Postpone from J3 May';
  assert.strictEqual(isPostponedText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"Mide 2025 , previously postponed code J2, September" is active', () => {
  const text = 'Mide 2025 , previously postponed code J2, September';
  assert.strictEqual(isPostponedText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"PAID DURING 2025 OCT TRIP WHICH POSTPONE" is active', () => {
  const text = 'PAID DURING 2025 OCT TRIP WHICH POSTPONE';
  assert.strictEqual(isPostponedText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"Previously cancelled due to weather " is active', () => {
  const text = 'Previously cancelled due to weather ';
  assert.strictEqual(isCancelledText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"Request Side by Side room dont change" is active', () => {
  const text = 'Request Side by Side room dont change';
  assert.strictEqual(isChangedText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"14-15 Change to dorm female" is active', () => {
  const text = '14-15 Change to dorm female';
  assert.strictEqual(isChangedText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"Initially 4D3N with 7 Dives. Now change to 3D2N" is active', () => {
  const text = 'Initially 4D3N with 7 Dives. Now change to 3D2N';
  assert.strictEqual(isChangedText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

it('"cancel 1 pax Extension Night RM194.40 (refunded on 10/03/26)" is active', () => {
  const text = 'cancel 1 pax Extension Night RM194.40 (refunded on 10/03/26)';
  assert.strictEqual(isCancelledText(text), false);
  assert.strictEqual(isSpecialRemarkText(text), false);
});

// ── Test Cases: Truly Inactive Bookings ──────────────────────────────────────

it('"POSTPONE TO MAY" is inactive (postponed out)', () => {
  const text = 'POSTPONE TO MAY';
  assert.strictEqual(isPostponedText(text), true);
  assert.strictEqual(isSpecialRemarkText(text), true);
});

it('"POSTPONED" is inactive (postponed out)', () => {
  const text = 'POSTPONED';
  assert.strictEqual(isPostponedText(text), true);
  assert.strictEqual(isSpecialRemarkText(text), true);
});

it('"Drt 2026/ Postponed due to leg injury" is inactive', () => {
  const text = 'Drt 2026/ Postponed due to leg injury';
  assert.strictEqual(isPostponedText(text), true);
  assert.strictEqual(isSpecialRemarkText(text), true);
});

it('"Change to July" is inactive (changed out)', () => {
  const text = 'Change to July';
  assert.strictEqual(isChangedText(text), true);
  assert.strictEqual(isSpecialRemarkText(text), true);
});

it('"cHANGE TO CODE K2" is inactive (changed out)', () => {
  const text = 'cHANGE TO CODE K2';
  assert.strictEqual(isChangedText(text), true);
  assert.strictEqual(isSpecialRemarkText(text), true);
});

it('"Cancelled" is inactive', () => {
  const text = 'Cancelled';
  assert.strictEqual(isCancelledText(text), true);
  assert.strictEqual(isSpecialRemarkText(text), true);
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 All Remark Classification tests passed successfully!');
}
