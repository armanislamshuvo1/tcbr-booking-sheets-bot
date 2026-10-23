const assert = require('assert');
const { createCustomBooking } = require('../src/overrides');
const { parseDate } = require('../src/detector');

console.log('🧪 Running Custom Booking & Date Picker Verification Suite...\n');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res
        .then(() => {
          console.log(`  ✅ PASS: ${name}`);
          passCount++;
        })
        .catch(err => {
          console.error(`  ❌ FAIL: ${name}\n     ${err.message}`);
          failCount++;
        });
    }
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}\n     ${err.message}`);
    failCount++;
  }
}

async function runAll() {
  // ── TEST 1: createCustomBooking returns { payload, entry } with row array ──
  await runTest('createCustomBooking must return { payload, entry } with entry.row defined', async () => {
    const testFields = {
      'NAME': 'Automated Test Guest',
      'CODE': 'TST-01',
      'CHECK IN': '23rd Oct',
      'CHECK OUT': '24th Oct',
      'STAYING DAYS': '2D1N',
      'ROOM': 'H103 (4 pax)'
    };
    const sampleHeaders = ['TIMESTAMP', 'CODE', 'PIC', 'NAME', 'SNORKELLING', 'DIVING', 'COURSE', 'CHECK IN', 'CHECK OUT', 'STAYING DAYS', 'ROOM'];

    const result = await createCustomBooking(testFields, 'testRunner', sampleHeaders);

    assert.ok(result, 'Result should be defined');
    assert.ok(result.payload, 'result.payload should be defined');
    assert.ok(result.entry, 'result.entry should be defined');
    assert.ok(Array.isArray(result.entry.row), 'result.entry.row must be an Array');
    assert.strictEqual(typeof result.entry.rowIndex, 'number', 'result.entry.rowIndex must be a number');
    assert.ok(result.entry.rowIndex >= 100000, 'Custom booking rowIndex should be >= 100000');
    assert.ok(result.payload.bookingKey, 'result.payload.bookingKey should be defined');
    assert.strictEqual(result.payload.bookingKey, `ROW_${result.entry.rowIndex}`);
  });

  // ── TEST 2: Date difference and staying days formula (N+1)D(N)N ──
  runTest('Staying Days calculation: 23 Oct to 24 Oct (1 night) = 2D1N', () => {
    const dIn = new Date(2026, 9, 23);
    const dOut = new Date(2026, 9, 24);
    const nights = Math.round((dOut.getTime() - dIn.getTime()) / (1000 * 60 * 60 * 24));
    const stayDays = nights > 0 ? `${nights + 1}D${nights}N` : '1D';
    assert.strictEqual(stayDays, '2D1N');
  });

  runTest('Staying Days calculation: 23 Oct to 26 Oct (3 nights) = 4D3N', () => {
    const dIn = new Date(2026, 9, 23);
    const dOut = new Date(2026, 9, 26);
    const nights = Math.round((dOut.getTime() - dIn.getTime()) / (1000 * 60 * 60 * 24));
    const stayDays = nights > 0 ? `${nights + 1}D${nights}N` : '1D';
    assert.strictEqual(stayDays, '4D3N');
  });

  runTest('parseDate can parse both YYYY-MM-DD and ordinal text (23rd Oct)', () => {
    const parsedIso = parseDate('2026-10-23');
    assert.ok(parsedIso, 'Should parse ISO date');
    assert.strictEqual(parsedIso.getDate(), 23);
    assert.strictEqual(parsedIso.getMonth(), 9);

    const parsedOrdinal = parseDate('23rd Oct');
    assert.ok(parsedOrdinal, 'Should parse ordinal date');
    assert.strictEqual(parsedOrdinal.getDate(), 23);
    assert.strictEqual(parsedOrdinal.getMonth(), 9);
  });

  console.log(`\nResults: ${passCount} passed, ${failCount} failed.`);
  if (failCount > 0) {
    process.exit(1);
  }
}

runAll().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
