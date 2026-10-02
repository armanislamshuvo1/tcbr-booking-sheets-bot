const assert = require('assert');
const { parsePax, parseDivingPax, parseCoursePax } = require('../src/weeklyReport');

console.log('🧪 Running Pax Parsing & Edge Case Verification Suite...\n');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}\n     ${err.message}`);
    failCount++;
  }
}

// ── PROBLEM 1: INSTA 360 WORKSHOP ──────────────────────────────────────────
runTest('Problem 1: Michelle (W2) - "1A (4 Dives) INSTA 360 WORKSHOP" must parse as 1 adult', () => {
  const res = parseDivingPax('1A (4 Dives) INSTA 360 WORKSHOP');
  assert.strictEqual(res.a, 1, `Expected 1 adult, got ${res.a}`);
  assert.strictEqual(res.c, 0);
  assert.strictEqual(res.b, 0);
});

runTest('Problem 1: Dolphin & Brenda (W2) - "2A & INSTA 360 WORKSHOP" must parse as 2 adults', () => {
  const res = parseDivingPax('2A & INSTA 360 WORKSHOP');
  assert.strictEqual(res.a, 2, `Expected 2 adults, got ${res.a}`);
  assert.strictEqual(res.c, 0);
});

runTest('Problem 1: Course with INSTA 360 WORKSHOP does not count 360 as students', () => {
  const res = parseCoursePax('1 OWC INSTA 360 WORKSHOP');
  assert.strictEqual(res.a, 1, `Expected 1 student, got ${res.a}`);
});

runTest('Problem 1: Snorkelling with INSTA 360 does not count 360', () => {
  const res = parsePax('4C INSTA 360 WORKSHOP');
  assert.strictEqual(res.c, 4);
  assert.strictEqual(res.a, 0);
});

// ── PROBLEM 3: ACCOMPANYING DM/INSTRUCTOR TRIPLE COUNTING ──────────────────
runTest('Problem 3: Tim Yeo (A) - "10A (7 Dives) + 1A accompanying DM/Instructor" must parse as 11 adults', () => {
  const res = parseDivingPax('10A (7 Dives) + 1A accompanying DM/Instructor');
  assert.strictEqual(res.a, 11, `Expected 11 adults, got ${res.a}`);
  assert.strictEqual(res.c, 0);
});

runTest('Compound role: "1 DM/Instructor" counts as 1 adult (not 2)', () => {
  const res = parseDivingPax('1 DM/Instructor');
  assert.strictEqual(res.a, 1, `Expected 1 adult, got ${res.a}`);
});

runTest('Compound role: "2A + 1 DM/Instructor" counts as 3 adults', () => {
  const res = parseDivingPax('2A + 1 DM/Instructor');
  assert.strictEqual(res.a, 3, `Expected 3 adults, got ${res.a}`);
});

runTest('Single role: "2A + 1 DM" counts as 3 adults', () => {
  const res = parseDivingPax('2A + 1 DM');
  assert.strictEqual(res.a, 3, `Expected 3 adults, got ${res.a}`);
});

runTest('Accompanying DM: "1A accompanying DM" counts as 1 adult (not 2)', () => {
  const res = parseDivingPax('1A accompanying DM');
  assert.strictEqual(res.a, 1, `Expected 1 adult, got ${res.a}`);
});

// ── REFRESHER COURSES & NON-PAX TEXT ───────────────────────────────────────
runTest('Refresher course: "2A (6 Dives) + Refresher Course for 2 pax" counts 2 adults', () => {
  const res = parseDivingPax('2A (6 Dives) + Refresher Course for 2 pax');
  assert.strictEqual(res.a, 2, `Expected 2 adults, got ${res.a}`);
});

// ── STANDARD DIVING, SNORKELLING & COURSE FORMATS ───────────────────────────
runTest('Standard diving: "3A (5 Dives)" counts as 3 adults', () => {
  const res = parseDivingPax('3A (5 Dives)');
  assert.strictEqual(res.a, 3);
});

runTest('Standard mixed pax: "4A 2C 1Baby"', () => {
  const res = parsePax('4A 2C 1Baby');
  assert.strictEqual(res.a, 4);
  assert.strictEqual(res.c, 2);
  assert.strictEqual(res.b, 1);
});

runTest('Bare number diving: "2" counts as 2 adults', () => {
  const res = parseDivingPax('2');
  assert.strictEqual(res.a, 2);
});

runTest('Course parsing: "4 OWC"', () => {
  const res = parseCoursePax('4 OWC');
  assert.strictEqual(res.a, 4);
});

console.log(`\nResults: ${passCount} passed, ${failCount} failed.`);
if (failCount > 0) {
  process.exit(1);
} else {
  console.log('🎉 All test suites passed successfully!\n');
}
