const assert = require('assert');
const {
  isSharedRoom,
  normalizeRoomCode,
  parseRoomString,
  buildHousekeepingReport,
  formatHousekeepingDayMessage,
  appendHousekeepingTimestamp,
} = require('../src/housekeepingReport');

console.log('🧪 Running Housekeeping Room List Test Suite...\n');

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

// ── TEST 1: SHARED ROOM CLASSIFICATION ──────────────────────────────────────
runTest('Shared rooms: Only D105, D106, D5, D6 are shared rooms', () => {
  assert.strictEqual(isSharedRoom('D105'), true);
  assert.strictEqual(isSharedRoom('D106'), true);
  assert.strictEqual(isSharedRoom('D5'), true);
  assert.strictEqual(isSharedRoom('D6'), true);

  // Private chalets / rooms must NOT be shared
  assert.strictEqual(isSharedRoom('D101'), false);
  assert.strictEqual(isSharedRoom('D102'), false);
  assert.strictEqual(isSharedRoom('D103'), false);
  assert.strictEqual(isSharedRoom('D104'), false);
  assert.strictEqual(isSharedRoom('B104'), false);
  assert.strictEqual(isSharedRoom('B109'), false);
  assert.strictEqual(isSharedRoom('H108'), false);
  assert.strictEqual(isSharedRoom('V102'), false);
  assert.strictEqual(isSharedRoom('S101'), false);
});

// ── TEST 2: ROOM STRING PARSING ─────────────────────────────────────────────
runTest('parseRoomString: Multi-room comma-separated with pax', () => {
  const rooms = parseRoomString('H107 (3 Pax), H108 (4 Pax)');
  assert.strictEqual(rooms.length, 2);
  assert.strictEqual(rooms[0].room, 'H107');
  assert.strictEqual(rooms[0].pax, 3);
  assert.strictEqual(rooms[0].isShared, false);
  assert.strictEqual(rooms[1].room, 'H108');
  assert.strictEqual(rooms[1].pax, 4);
  assert.strictEqual(rooms[1].isShared, false);
});

runTest('parseRoomString: Shared room D5 (6 Pax) normalizes to D105 with pax 6', () => {
  const rooms = parseRoomString('D5 (6 Pax)');
  assert.strictEqual(rooms.length, 1);
  assert.strictEqual(rooms[0].room, 'D105');
  assert.strictEqual(rooms[0].pax, 6);
  assert.strictEqual(rooms[0].isShared, true);
});

runTest('parseRoomString: Private room D104 (2 Pax) has isShared = false', () => {
  const rooms = parseRoomString('D104 (2 Pax)');
  assert.strictEqual(rooms.length, 1);
  assert.strictEqual(rooms[0].room, 'D104');
  assert.strictEqual(rooms[0].pax, 2);
  assert.strictEqual(rooms[0].isShared, false);
});

runTest('parseRoomString: Unassigned or empty strings return empty array', () => {
  assert.deepStrictEqual(parseRoomString('—'), []);
  assert.deepStrictEqual(parseRoomString('-'), []);
  assert.deepStrictEqual(parseRoomString('TBA'), []);
  assert.deepStrictEqual(parseRoomString(''), []);
  assert.deepStrictEqual(parseRoomString(null), []);
});

// ── TEST 3: BACK-TO-BACK (b2b) DETECTION & FORMATTING ────────────────────────
runTest('formatHousekeepingDayMessage: Reproduces exact user example for 11/10', () => {
  const mockDay = {
    dayMonth: '11/10',
    checkOuts: [
      { room: 'D105', pax: 6, isShared: true, b2b: true },
      { room: 'H108', pax: 2, isShared: false, b2b: false },
      { room: 'D104', pax: 2, isShared: false, b2b: true },
      { room: 'V102', pax: 4, isShared: false, b2b: false },
      { room: 'B104', pax: 2, isShared: false, b2b: false },
      { room: 'B106', pax: 2, isShared: false, b2b: false },
      { room: 'B107', pax: 2, isShared: false, b2b: false },
      { room: 'V107', pax: 2, isShared: false, b2b: false },
      { room: 'B108', pax: 2, isShared: false, b2b: false },
      { room: 'B109', pax: 2, isShared: false, b2b: true },
      { room: 'V108', pax: 2, isShared: false, b2b: false },
      { room: 'D103', pax: 2, isShared: false, b2b: true },
    ],
    checkIns: [
      { room: 'B109', pax: 4, isShared: false },
      { room: 'D105', pax: 1, isShared: true },
      { room: 'D104', pax: 2, isShared: false },
      { room: 'D103', pax: 2, isShared: false },
    ],
  };

  const formatted = formatHousekeepingDayMessage(mockDay, { format: 'whatsapp' });

  // Verification assertions
  assert.ok(formatted.includes('*Check out 11/10*'));
  assert.ok(formatted.includes('* D105 - 6 b2b'), 'D105 should show pax 6 and b2b because it is shared and b2b');
  assert.ok(formatted.includes('* H108'), 'H108 should omit pax because it is private');
  assert.ok(formatted.includes('* D104 b2b'), 'D104 should omit pax (private) and include b2b');
  assert.ok(formatted.includes('* B109 b2b'), 'B109 should omit pax (private) and include b2b');
  assert.ok(formatted.includes('*Check in*'));
  assert.ok(formatted.includes('* B109 - 4'));
  assert.ok(formatted.includes('* D105 - 1'));
  assert.ok(formatted.includes('* D104 - 2'));
  assert.ok(formatted.includes('* D103 - 2'));
});

// ── TEST 4: EMPTY ARRIVALS ("Belum ada Check in") ───────────────────────────
runTest('formatHousekeepingDayMessage: Produces "*Belum ada Check in*" when no check-ins', () => {
  const mockDay = {
    dayMonth: '13/10',
    checkOuts: [
      { room: 'B103', pax: 2, isShared: false, b2b: false },
      { room: 'V103', pax: 1, isShared: false, b2b: false },
      { room: 'D105', pax: 1, isShared: true, b2b: false },
    ],
    checkIns: [],
  };

  const formatted = formatHousekeepingDayMessage(mockDay, { format: 'whatsapp' });

  assert.ok(formatted.includes('*Check out 13/10*'));
  assert.ok(formatted.includes('* B103'));
  assert.ok(formatted.includes('* V103'));
  assert.ok(formatted.includes('* D105 - 1'));
  assert.ok(formatted.includes('*Belum ada Check in*'));
  assert.strictEqual(formatted.includes('*Check in*'), false);
});

// ── TEST 5: FULL PIPELINE FROM RAW SHEET ROWS ──────────────────────────────
runTest('buildHousekeepingReport: End-to-end report generation with b2b tagging', () => {
  const headers = ['CODE', 'NAME', 'CHECK IN', 'CHECK OUT', 'ROOM', 'ROOM_PAX'];
  const rows = [
    headers,
    // Booking 1: Leaves 11/10 from D105 (6 pax)
    ['BK1', 'Alice', '08/10/2026', '11/10/2026', 'D105 (6 Pax)', '6'],
    // Booking 2: Arrives 11/10 into D105 (1 pax)
    ['BK2', 'Bob', '11/10/2026', '14/10/2026', 'D105 (1 Pax)', '1'],
    // Booking 3: Leaves 11/10 from D104 (2 pax)
    ['BK3', 'Charlie', '08/10/2026', '11/10/2026', 'D104 (2 Pax)', '2'],
    // Booking 4: Arrives 11/10 into D104 (2 pax)
    ['BK4', 'David', '11/10/2026', '15/10/2026', 'D104 (2 Pax)', '2'],
    // Booking 5: Leaves 11/10 from H108 (no arrival on 11/10)
    ['BK5', 'Eve', '07/10/2026', '11/10/2026', 'H108 (2 Pax)', '2'],
  ];

  const report = buildHousekeepingReport(rows, {
    startDateStr: '2026-10-11',
    endDateStr: '2026-10-11',
    headers,
  });

  assert.strictEqual(report.days.length, 1);
  const day = report.days[0];
  assert.strictEqual(day.dayMonth, '11/10');
  assert.strictEqual(day.checkOuts.length, 3);
  assert.strictEqual(day.checkIns.length, 2);

  const d105Out = day.checkOuts.find(c => c.room === 'D105');
  assert.ok(d105Out);
  assert.strictEqual(d105Out.b2b, true);
  assert.strictEqual(d105Out.isShared, true);
  assert.strictEqual(d105Out.pax, 6);

  const d104Out = day.checkOuts.find(c => c.room === 'D104');
  assert.ok(d104Out);
  assert.strictEqual(d104Out.b2b, true);
  assert.strictEqual(d104Out.isShared, false);

  const h108Out = day.checkOuts.find(c => c.room === 'H108');
  assert.ok(h108Out);
  assert.strictEqual(h108Out.b2b, false);

  const msg = formatHousekeepingDayMessage(day);
  assert.ok(msg.includes('* D105 - 6 b2b'));
  assert.ok(msg.includes('* D104 b2b'));
  assert.ok(msg.includes('* H108'));
  assert.ok(msg.includes('* D105 - 1'));
  assert.ok(msg.includes('* D104 - 2'));
});

// ── TEST 6: MID-STAY ROOM MOVE (TRANSITION) ─────────────────────────────────
runTest('buildHousekeepingReport: Mid-stay room shift (➔) properly tracks move date turnover', () => {
  const headers = ['CODE', 'NAME', 'CHECK IN', 'CHECK OUT', 'ROOM', 'ROOM_PAX'];
  const rows = [
    headers,
    // Booking 1 stays 10/10 to 14/10, but switches rooms on 12/10
    ['BK1', 'John Doe', '10/10/2026', '14/10/2026', 'D104 ➔ D105 (Changed on 12 Oct)', '2'],
  ];

  const report = buildHousekeepingReport(rows, {
    startDateStr: '2026-10-10',
    endDateStr: '2026-10-14',
    headers,
  });

  // Day 1 (10/10): Check-in D104
  const day10 = report.days.find(d => d.dateStr === '2026-10-10');
  assert.ok(day10.checkIns.some(c => c.room === 'D104'));

  // Day 3 (12/10): Room move! D104 checks out, D105 checks in
  const day12 = report.days.find(d => d.dateStr === '2026-10-12');
  assert.ok(day12.checkOuts.some(c => c.room === 'D104'));
  assert.ok(day12.checkIns.some(c => c.room === 'D105'));

  // Day 5 (14/10): Final check-out D105
  const day14 = report.days.find(d => d.dateStr === '2026-10-14');
  assert.ok(day14.checkOuts.some(c => c.room === 'D105'));
});

// ── TEST 7: COMBINE IDENTICAL ROOMS (USER'S ISSUE) ──────────────────────────
runTest('buildHousekeepingReport: Combines multiple bookings in same room (e.g. 3x D105-2 -> D105-6, 2x D103-2 -> D103-4)', () => {
  const headers = ['CODE', 'NAME', 'CHECK IN', 'CHECK OUT', 'ROOM', 'ROOM_PAX'];
  const rows = [
    headers,
    // 3 separate bookings checking out of D105 with 2 pax each on 11/10
    ['BK1', 'Guest 1', '08/10/2026', '11/10/2026', 'D105 (2 Pax)', '2'],
    ['BK2', 'Guest 2', '08/10/2026', '11/10/2026', 'D105 (2 Pax)', '2'],
    ['BK3', 'Guest 3', '08/10/2026', '11/10/2026', 'D105 (2 Pax)', '2'],
    // 1 booking checking into D105 on 11/10 (makes D105 b2b)
    ['BK4', 'Guest 4', '11/10/2026', '14/10/2026', 'D105 (1 Pax)', '1'],
    // 2 bookings checking into D103 with 2 pax each on 11/10
    ['BK5', 'Guest 5', '11/10/2026', '14/10/2026', 'D103 (2 Pax)', '2'],
    ['BK6', 'Guest 6', '11/10/2026', '14/10/2026', 'D103 (2 Pax)', '2'],
    // Private room checking out
    ['BK7', 'Guest 7', '08/10/2026', '11/10/2026', 'H108 (2 Pax)', '2'],
  ];

  const report = buildHousekeepingReport(rows, {
    startDateStr: '2026-10-11',
    endDateStr: '2026-10-11',
    headers,
  });

  const day = report.days[0];
  const msg = formatHousekeepingDayMessage(day, { format: 'whatsapp' });

  // D105 checkOuts should be combined into 1 entry with pax = 6 (2 + 2 + 2) and b2b = true
  const d105Out = day.checkOuts.filter(c => c.room === 'D105');
  assert.strictEqual(d105Out.length, 1, 'D105 should appear only once in checkOuts');
  assert.strictEqual(d105Out[0].pax, 6, 'D105 pax should be summed to 6');
  assert.strictEqual(d105Out[0].b2b, true, 'D105 should be marked b2b');

  // D103 checkIns should be combined into 1 entry with pax = 4 (2 + 2)
  const d103In = day.checkIns.filter(c => c.room === 'D103');
  assert.strictEqual(d103In.length, 1, 'D103 should appear only once in checkIns');
  assert.strictEqual(d103In[0].pax, 4, 'D103 pax should be summed to 4');

  // Formatted message checks
  assert.ok(msg.includes('* D105 - 6 b2b'), 'Message must contain "* D105 - 6 b2b"');
  assert.ok(msg.includes('* D103 - 4'), 'Message must contain "* D103 - 4"');
  assert.ok(msg.includes('* H108'), 'Private room H108 must omit pax');

  // Ensure there are no duplicate "* D105" or "* D103" lines
  const d105Matches = msg.match(/\*\s*D105[^\n]*/g) || [];
  assert.strictEqual(d105Matches.length, 2, 'D105 should appear exactly once in checkOut and once in checkIn');
  const d103Matches = msg.match(/\*\s*D103[^\n]*/g) || [];
  assert.strictEqual(d103Matches.length, 1, 'D103 should appear exactly once in checkIn');
});

// ── TEST 8: MULTI-ROW BOOKINGS (MEHDI & MILAD CASE) ─────────────────────────
runTest('buildHousekeepingReport: Uses actual row guest count when room string has total code capacity (e.g. Mehdi 1A & Milad 1A sharing D3)', () => {
  const headers = ['CODE', 'NAME', 'CHECK IN', 'CHECK OUT', 'SNORKELLING', 'DIVING', 'COURSE', 'ROOM', 'ROOM_PAX'];
  const rows = [
    headers,
    // Row 1: Mehdi Mehrtash, Code J1, Snorkelling 1A (1 Pax), Room D3 (2 Pax)
    ['J1', 'Mehdi Mehrtash', '11/10/2026', '16/10/2026', '1A', '', '', 'D3 (2 Pax)', '2'],
    // Row 2: Milad Fakourdabbaghi, Code J1, Snorkelling 1A (1 Pax), Room D3 (2 Pax)
    ['J1', 'Milad Fakourdabbaghi', '11/10/2026', '16/10/2026', '1A', '', '', 'D3 (2 Pax)', '2'],
  ];

  const report = buildHousekeepingReport(rows, {
    startDateStr: '2026-10-11',
    endDateStr: '2026-10-11',
    headers,
  });

  const day = report.days[0];
  const d103In = day.checkIns.find(c => c.room === 'D103');
  assert.ok(d103In, 'D103 should be in checkIns');
  assert.strictEqual(d103In.pax, 2, 'D103 pax must be 1 + 1 = 2 (not 2 + 2 = 4)');

  const msg = formatHousekeepingDayMessage(day, { format: 'whatsapp' });
  assert.ok(msg.includes('* D103 - 2'), 'Formatted check-in message must be "* D103 - 2"');
});

// ── TEST 9: TIMESTAMP FOOTER (LAST UPDATED MENTION) ─────────────────────────
runTest('appendHousekeepingTimestamp: Appends correct footer matching boat transfer format', () => {
  const sampleText = '*Check out 11/10*\n* D105 - 6 b2b\n\n*Check in*\n* B109 - 4';
  const fixedDate = new Date('2026-10-10T15:45:00+08:00'); // 03:45 PM KL time

  // WhatsApp format: _Last updated: 03:45 PM, 10/10_
  const waText = appendHousekeepingTimestamp(sampleText, fixedDate, 'whatsapp');
  assert.ok(waText.includes('_Last updated: 03:45 PM, 10/10_'), 'WhatsApp format must have _Last updated: 03:45 PM, 10/10_');
  assert.ok(waText.startsWith(sampleText), 'Should preserve original message body');

  // Telegram HTML format: <i>Last updated: 03:45 PM, 10/10</i>
  const tgText = appendHousekeepingTimestamp(sampleText, fixedDate, 'telegramHtml');
  assert.ok(tgText.includes('<i>Last updated: 03:45 PM, 10/10</i>'), 'Telegram HTML must have <i>Last updated: 03:45 PM, 10/10</i>');
});

runTest('formatHousekeepingDayMessage: Supports includeTimestamp option', () => {
  const mockDay = {
    dayMonth: '11/10',
    checkOuts: [{ room: 'D105', pax: 6, isShared: true, b2b: true }],
    checkIns: [{ room: 'B109', pax: 4, isShared: false }],
  };
  const fixedDate = new Date('2026-10-10T15:45:00+08:00');

  const formatted = formatHousekeepingDayMessage(mockDay, {
    format: 'telegramHtml',
    includeTimestamp: true,
    now: fixedDate,
  });

  assert.ok(formatted.includes('<b>Check out 11/10</b>'));
  assert.ok(formatted.includes('<i>Last updated: 03:45 PM, 10/10</i>'));
});

// ── TEST 10: 10-DAY WINDOW & AUTO-UPDATE IN-PLACE EDITING ───────────────────
runTest('getHousekeeping10DayWindow: Computes 10-day KL window accurately across UTC day boundary', () => {
  const { getHousekeeping10DayWindow } = require('../src/housekeepingReport');
  // 2026-09-30T20:00:00Z is 2026-10-01 04:00 AM KL time
  const boundaryDate = new Date('2026-09-30T20:00:00.000Z');
  const win = getHousekeeping10DayWindow(boundaryDate);
  assert.strictEqual(win.startStr, '2026-10-01');
  assert.strictEqual(win.endStr, '2026-10-10');
});

(async () => {
  const telegram = require('../src/telegram');
  const { sendHousekeepingAutoReport, getHousekeeping10DayWindow } = require('../src/housekeepingReport');

  const origSend = telegram.sendMessage;
  const origEdit = telegram.editMessageText;

  try {
    let sentCalls = [];
    let editCalls = [];
    let msgCounter = 1000;

    telegram.sendMessage = async (text, markup, chatId) => {
      const id = ++msgCounter;
      sentCalls.push({ id, text, chatId });
      return id;
    };
    telegram.editMessageText = async (chatId, messageId, text) => {
      editCalls.push({ chatId, messageId, text });
      return true;
    };

    const { startStr, endStr } = getHousekeeping10DayWindow(new Date());
    const headers = ['CODE', 'NAME', 'CHECK IN', 'CHECK OUT', 'ROOM', 'ROOM_PAX'];
    const initialRows = [
      headers,
      ['BK1', 'Alice', startStr, endStr, 'D104 (2 Pax)', '2'],
    ];

    // 1. Initial send: should send 10 new messages
    const firstRun = await sendHousekeepingAutoReport(initialRows, 'hk_channel', 'scheduled', null, []);
    await runTest('sendHousekeepingAutoReport: Sends 10 initial messages when no prevMessages exist', () => {
      assert.strictEqual(sentCalls.length, 10);
      assert.strictEqual(editCalls.length, 0);
      assert.strictEqual(Object.keys(firstRun.messages.dateMessages).length, 10);
    });

    // 2. Non-housekeeping change on startStr (changedDates includes startStr, but room list hash unchanged)
    sentCalls = [];
    editCalls = [];
    const secondRun = await sendHousekeepingAutoReport(initialRows, 'hk_channel', 'updated', firstRun.messages, [startStr]);
    await runTest('sendHousekeepingAutoReport: Does not send or edit when room content hash is unchanged even if date is in changedDates', () => {
      assert.strictEqual(sentCalls.length, 0, 'Must not send new messages');
      assert.strictEqual(editCalls.length, 0, 'Must not edit unchanged housekeeping messages');
      assert.deepStrictEqual(secondRun.messages.dateMessages, firstRun.messages.dateMessages);
    });

    // 3. Room change on startStr: should edit ONLY startStr in-place, never send a new message
    const updatedRows = [
      headers,
      ['BK1', 'Alice', startStr, endStr, 'B109 (4 Pax)', '4'],
    ];
    sentCalls = [];
    editCalls = [];
    const thirdRun = await sendHousekeepingAutoReport(updatedRows, 'hk_channel', 'updated', secondRun.messages, [startStr, endStr]);
    await runTest('sendHousekeepingAutoReport: Edits existing messages in-place when room list changes instead of sending new messages', () => {
      assert.strictEqual(sentCalls.length, 0, 'Must NOT send any new messages when updating existing dates');
      assert.strictEqual(editCalls.length, 2, 'Should edit only startStr and endStr where room changed');
      assert.strictEqual(thirdRun.messages.dateMessages[startStr], firstRun.messages.dateMessages[startStr], 'Message ID must be preserved');
    });

    // 4. Transient edit failure (returns false): must NOT send duplicate new message, and must keep old hash to retry next run
    telegram.editMessageText = async () => false;
    const moreRows = [
      headers,
      ['BK1', 'Alice', startStr, endStr, 'V102 (2 Pax)', '2'],
    ];
    sentCalls = [];
    editCalls = [];
    const fourthRun = await sendHousekeepingAutoReport(moreRows, 'hk_channel', 'updated', thirdRun.messages, [startStr]);
    await runTest('sendHousekeepingAutoReport: Does NOT send duplicate message when editMessageText returns false (transient error)', () => {
      assert.strictEqual(sentCalls.length, 0, 'Must NOT fall back to sendMessage on transient edit failure');
      assert.strictEqual(fourthRun.messages.dateMessages[startStr], thirdRun.messages.dateMessages[startStr], 'Must keep prevMsgId');
      assert.strictEqual(fourthRun.messages.dateHashes[startStr], thirdRun.messages.dateHashes[startStr], 'Must keep prevHash so next run retries');
    });

    // 5. Multi-room multi-row booking (e.g. X3 Zetty + Janie on Row 1391/1392) does not double-sum room pax
    await runTest('buildHousekeepingReport: Multi-room continuation rows sharing the same CODE do not double-sum room capacities', () => {
      const x3Rows = [
        ['CODE', 'NAME', 'SNORKELLING', 'DIVING', 'COURSE', 'CHECK IN', 'CHECK OUT', 'ROOM', 'ROOM_PAX'],
        ['X3', 'Zetty', '6A 1C', '', '', '18 Oct 2026', '21 Oct 2026', 'S101 (4 Pax), B104 (3 Pax), B105 (4 Pax)', '11'],
        ['X3', 'Janie', '2A 2C', '', '', '18 Oct 2026', '21 Oct 2026', 'S101 (4 Pax), B104 (3 Pax), B105 (4 Pax)', '11'],
      ];
      const rep = buildHousekeepingReport(x3Rows, {
        startDateStr: '2026-10-18',
        endDateStr: '2026-10-18',
      });
      const day = rep.days[0];
      assert.strictEqual(day.checkIns.length, 3);
      const b104 = day.checkIns.find(r => r.room === 'B104');
      const b105 = day.checkIns.find(r => r.room === 'B105');
      const s101 = day.checkIns.find(r => r.room === 'S101');
      assert.strictEqual(b104.pax, 3);
      assert.strictEqual(b105.pax, 4);
      assert.strictEqual(s101.pax, 4);
    });

    // 6. buildCurrentMonthMap & overrides: Row 1392 continuation row inheritance, amendment, and custom booking creation
    await runTest('buildCurrentMonthMap & overrides: Uncoded continuation row inherits dates, supports override amendment, and custom bookings work', async () => {
      const { buildCurrentMonthMap } = require('../src/detector');
      const { attachRowMeta, applyOverridesToRows, buildCustomBookingEntry } = require('../src/overrides');

      const sheetHeaders = [
        'NO', 'CODE', 'PIC', 'NAME', 'SNORKELLING', 'DIVING', 'COURSE',
        'CHECK IN', 'CHECK OUT', 'STAYING DAYS', 'ROOM TYPE', 'SHARING', 'BED',
        'SPECIAL REQUEST', '', '', '', '', 'TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS', 'REMARK', '', '', 'ROW_COLOR', 'ROOM', 'ROOM_PAX'
      ];
      const row1391 = ['', 'X3', 'Jen', 'Zetty', '6A 1C', '', '', '18th Oct', '21st Oct', '4D3N', '2 Beach front deluxe', 'Triple,quD', '', '', '', '', '', '', '', '', '', '', '', '', '', 'rgb(255,0,0)', 'S101 (4 Pax), B104 (3 Pax), B105 (4 Pax)', 11];
      const row1392 = ['', 'X3', 'Jen', 'Janie', '2A 2C', '', '', '18th Oct', '21st Oct', '4D3N', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'rgb(255,0,0)', 'S101 (4 Pax), B104 (3 Pax), B105 (4 Pax)', 11];
      attachRowMeta(row1392, {
        inheritedMeta: {
          fromRow: 1391,
          fromCode: 'X3',
          fields: ['CODE', 'PIC', 'CHECK IN', 'CHECK OUT', 'STAYING DAYS']
        }
      });

      const refOct = new Date(2026, 9, 18);
      const monthMap = buildCurrentMonthMap([sheetHeaders, row1391, row1392], refOct);
      assert.ok(monthMap['row1'], 'Parent row should be in monthMap');
      assert.ok(monthMap['row2'], 'Continuation row (Janie) should be in monthMap');
      assert.deepStrictEqual(monthMap['row2'].inheritedMeta.fields, ['CODE', 'PIC', 'CHECK IN', 'CHECK OUT', 'STAYING DAYS']);

      // Amend inherited row via applyOverridesToRows
      const singleOverride = {
        ROW_2: {
          bookingKey: 'ROW_2',
          fields: { CODE: 'X4', PIC: 'Alex', SHARING: 'Quad', BED: '2 Queen' },
          updatedBy: 'admin',
          updatedAt: '2026-10-18T00:00:00.000Z'
        }
      };
      const [amended] = await applyOverridesToRows([monthMap['row2']], sheetHeaders, singleOverride);
      assert.strictEqual(amended.row[1], 'X4');
      assert.strictEqual(amended.row[2], 'Alex');
      assert.strictEqual(amended.row[11], 'Quad');
      assert.strictEqual(amended.row[12], '2 Queen');
      assert.strictEqual(amended.isOverridden, true);
      assert.strictEqual(amended.inheritedMeta.fromCode, 'X3');

      // Custom booking creation
      const customEntry = buildCustomBookingEntry(100001, {
        bookingKey: 'ROW_100001',
        isCustomBooking: true,
        fields: {
          CODE: 'Z9',
          PIC: 'Jen',
          NAME: 'Custom Guest',
          'CHECK IN': '19th Oct',
          'CHECK OUT': '22nd Oct',
          'STAYING DAYS': '4D3N',
          SNORKELLING: '2A',
          SHARING: 'Double',
          BED: '1 King',
          ROOM: 'V101 (2 Pax)',
          ROOM_PAX: '2'
        },
        updatedBy: 'admin'
      }, sheetHeaders);
      assert.strictEqual(customEntry.isCustomBooking, true);
      assert.strictEqual(customEntry.rowIndex, 100001);
      assert.strictEqual(customEntry.row[1], 'Z9');
      assert.strictEqual(customEntry.row[3], 'Custom Guest');
      assert.strictEqual(customEntry.row[11], 'Double');
      assert.strictEqual(customEntry.row[12], '1 King');
    });
  } finally {
    telegram.sendMessage = origSend;
    telegram.editMessageText = origEdit;
  }

  console.log(`\nResults: ${passCount} passed, ${failCount} failed.`);
  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log('🎉 All Housekeeping Room List tests passed successfully!');
  }
})();
