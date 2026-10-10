const { parseDate, findHeaderRowIndex, isSpecialRemarkText } = require('./detector');
const { parsePax, parseDivingPax, parseCoursePax } = require('./weeklyReport');

const KL_TIMEZONE = 'Asia/Kuala_Lumpur';

/**
 * Calculates actual guest count for a booking row from Snorkelling, Diving, and Course activities.
 * @param {Array} row
 * @param {Array} headers
 * @returns {number}
 */
function getRowGuestCount(row, headers) {
  if (!row || !Array.isArray(row)) return 0;
  let snorkelIdx = headers.findIndex(h => h && (h.toString().trim().toUpperCase() === 'SNORKELLING' || h.toString().trim().toUpperCase() === 'SNORKEL' || h.toString().toUpperCase().includes('SNORKEL')));
  if (snorkelIdx === -1) snorkelIdx = 4;

  let divingIdx = headers.findIndex(h => h && (h.toString().trim().toUpperCase() === 'DIVING' || h.toString().trim().toUpperCase() === 'DIVE' || h.toString().toUpperCase().includes('DIVE')));
  if (divingIdx === -1) divingIdx = 5;

  let courseIdx = headers.findIndex(h => h && (h.toString().trim().toUpperCase() === 'COURSE' || h.toString().toUpperCase().includes('COURSE')));
  if (courseIdx === -1) courseIdx = 6;

  const snorkelStr = (snorkelIdx !== -1 && row[snorkelIdx]) ? row[snorkelIdx].toString().trim() : '';
  const divingStr  = (divingIdx  !== -1 && row[divingIdx])  ? row[divingIdx].toString().trim()  : '';
  const courseStr  = (courseIdx  !== -1 && row[courseIdx])  ? row[courseIdx].toString().trim()  : '';

  const s = parsePax(snorkelStr);
  const d = parseDivingPax(divingStr);
  const c = parseCoursePax(courseStr);

  return (s.a + s.c + s.b) + (d.a + d.c + d.b) + (c.a + c.c + c.b);
}

/**
 * Shared rooms at TCBR: Only D105 and D106 (and aliases D5, D6) are shared dormitories.
 * All other rooms (D101-D104, B101-B109, H101-H110, S101, V101-V108) are private rooms.
 */
const SHARED_ROOM_CODES = new Set(['D105', 'D106', 'D5', 'D6']);

/**
 * Checks if a given room code is a shared room.
 * @param {string} roomCode
 * @returns {boolean}
 */
function isSharedRoom(roomCode) {
  if (!roomCode) return false;
  return SHARED_ROOM_CODES.has(roomCode.toString().trim().toUpperCase());
}

/**
 * Normalizes room code display, e.g. "D5" -> "D105", "D6" -> "D106" if standard 3-digit format,
 * or keeps original code.
 */
function normalizeRoomCode(room) {
  if (!room) return '';
  const clean = room.toString().trim().toUpperCase();
  if (clean === 'D5') return 'D105';
  if (clean === 'D6') return 'D106';
  if (clean === 'D1') return 'D101';
  if (clean === 'D2') return 'D102';
  if (clean === 'D3') return 'D103';
  if (clean === 'D4') return 'D104';
  return clean;
}

/**
 * Get the KL timezone date components for a given Date object.
 */
function getKLDate(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: KL_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = formatter.formatToParts(date);
  return {
    year:  parseInt(parts.find(p => p.type === 'year').value, 10),
    month: parseInt(parts.find(p => p.type === 'month').value, 10) - 1,
    day:   parseInt(parts.find(p => p.type === 'day').value, 10),
  };
}

/**
 * Get KL date as a YYYY-MM-DD string.
 */
function toKLDateString(date) {
  const d = getKLDate(date);
  return `${d.year}-${String(d.month + 1).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/**
 * Format a Date into DD/MM string (e.g. 11/10).
 */
function formatDayMonth(date) {
  const d = getKLDate(date);
  return `${String(d.day).padStart(2, '0')}/${String(d.month + 1).padStart(2, '0')}`;
}

/**
 * Parses individual room allocations from a booking's ROOM string.
 * Supports:
 *   "H107 (3 Pax), H108 (4 Pax)" -> [{ room: 'H107', pax: 3 }, { room: 'H108', pax: 4 }]
 *   "B109 (2 Pax)"               -> [{ room: 'B109', pax: 2 }]
 *   "D5 (6 Pax)"                 -> [{ room: 'D105', pax: 6 }]
 *   "D105 ➔ D106 (Changed on 15 Sept)" -> transition handling
 *   "B104, B106"                 -> [{ room: 'B104', pax: defaultPax }, { room: 'B106', pax: defaultPax }]
 *
 * @param {string} roomStr
 * @param {number} fallbackPax
 * @returns {Array<{ room: string, pax: number, isShared: boolean }>}
 */
function parseRoomString(roomStr, fallbackPax = 1) {
  if (!roomStr || typeof roomStr !== 'string') return [];
  const clean = roomStr.trim();
  if (!clean || clean === '—' || clean === '-' || clean.toUpperCase() === 'TBA' || clean.toUpperCase() === 'PENDING') {
    return [];
  }

  // Check for mid-stay transition: "D105 ➔ D106 (Changed on 15 Sept)"
  if (clean.includes('➔') || clean.includes('->')) {
    const arrow = clean.includes('➔') ? '➔' : '->';
    const parts = clean.split(arrow);
    const rooms = [];
    parts.forEach((p, idx) => {
      // Remove any parenthetical notes like "(Changed on 15 Sept)"
      const stripped = p.replace(/\([^)]*\)/g, '').trim();
      const codeMatch = stripped.match(/([A-Z0-9]+)/i);
      if (codeMatch) {
        const rCode = normalizeRoomCode(codeMatch[1]);
        rooms.push({
          room: rCode,
          pax: fallbackPax || 1,
          isShared: isSharedRoom(rCode),
          isTransition: true,
          transitionIndex: idx, // 0 = initial room, 1 = subsequent room
        });
      }
    });
    return rooms;
  }

  // Handle standard comma-separated or parenthesis format: "H107 (3 Pax), H108 (4 Pax)"
  const segments = clean.split(',');
  const results = [];

  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;

    // Pattern: Room (X Pax)
    const matchWithPax = s.match(/([A-Z0-9]+)\s*\((?:(\d+)\s*(?:pax|p)?|.*?)\)/i);
    if (matchWithPax) {
      const rCode = normalizeRoomCode(matchWithPax[1]);
      const pax = matchWithPax[2] ? parseInt(matchWithPax[2], 10) : fallbackPax;
      results.push({
        room: rCode,
        pax: pax > 0 ? pax : 1,
        isShared: isSharedRoom(rCode),
      });
      continue;
    }

    // Bare room code: "B104" or "D105"
    const matchBare = s.match(/^([A-Z0-9]+)/i);
    if (matchBare) {
      const rCode = normalizeRoomCode(matchBare[1]);
      results.push({
        room: rCode,
        pax: fallbackPax > 0 ? fallbackPax : 1,
        isShared: isSharedRoom(rCode),
      });
    }
  }

  return results;
}

/**
 * Room comparator for natural sort order:
 * B (Beachfront) -> D (Deluxe/Dorm) -> H (Heritage/Hillview) -> S (Suite) -> V (Villa)
 * Then numeric room number.
 */
function compareRooms(a, b) {
  const roomA = a.room || '';
  const roomB = b.room || '';
  return roomA.localeCompare(roomB, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Aggregates room allocations by unique room code.
 * Combines multiple bookings in the same room (e.g. shared dorms with multiple occupants)
 * into a single line with summed pax.
 * @param {Array} list
 * @returns {Array}
 */
function aggregateRoomList(list) {
  const map = new Map();
  for (const item of list) {
    const roomKey = item.room;
    if (!map.has(roomKey)) {
      map.set(roomKey, {
        room: item.room,
        pax: 0,
        isShared: item.isShared,
        b2b: false,
        isRoomMove: false,
        codes: [],
        names: [],
      });
    }
    const agg = map.get(roomKey);
    agg.pax += (item.pax || 0);
    if (item.b2b) agg.b2b = true;
    if (item.isRoomMove) agg.isRoomMove = true;
    if (item.code) agg.codes.push(item.code);
    if (item.name) agg.names.push(item.name);
  }
  return Array.from(map.values());
}

/**
 * Builds the Housekeeping Report for a specified date range.
 *
 * @param {Array[]} rows - Raw or enriched sheet rows.
 * @param {Object} options - Options { startDateStr, endDateStr, filterType, headers, sortBy }
 * @returns {Object} Report structure containing days array and metrics.
 */
function buildHousekeepingReport(rows, options = {}) {
  const startDateStr = options.startDateStr || toKLDateString(new Date());
  const endDateStr   = options.endDateStr || startDateStr;
  const filterType   = options.filterType || 'both'; // 'both', 'checkout', 'checkin'
  const sortBy       = options.sortBy || 'natural'; // 'natural', 'b2bFirst'

  const startParsed = parseDate(startDateStr);
  const endParsed   = parseDate(endDateStr);

  const startKL = startParsed ? getKLDate(startParsed) : getKLDate(new Date());
  const endKL   = endParsed ? getKLDate(endParsed) : startKL;

  const startUtc = Date.UTC(startKL.year, startKL.month, startKL.day);
  const endUtc   = Date.UTC(endKL.year, endKL.month, endKL.day);

  let numDays = Math.max(1, Math.round((endUtc - startUtc) / (1000 * 60 * 60 * 24)) + 1);
  if (numDays > 31) numDays = 31; // Cap at 31 days max

  const days = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(startKL.year, startKL.month, startKL.day + i);
    days.push({
      date: d,
      dateStr: toKLDateString(d),
      dayMonth: formatDayMonth(d),
      checkOuts: [],
      checkIns: [],
    });
  }

  const dayDateMap = new Map();
  days.forEach(d => dayDateMap.set(d.dateStr, d));

  let headers = options.headers || [];
  if (!headers || headers.length === 0) {
    const headerIndex = findHeaderRowIndex(rows);
    const item = rows[headerIndex];
    headers = (item && Array.isArray(item.row)) ? (item.headers || item.row) : (item || []);
  }

  const firstItem = rows[0];
  const firstRow = (firstItem && Array.isArray(firstItem.row)) ? firstItem.row : firstItem;
  const startsWithHeader = Array.isArray(firstRow) && firstRow.some(c => typeof c === 'string' && c.trim().toUpperCase() === 'CODE');
  const startIdx = startsWithHeader ? 1 : 0;

  const codeIdx     = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
  const nameIdx     = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NAME');
  const checkInIdx  = headers.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN', 'CHECK IN DATE', 'CHECK-IN DATE'].includes(h.toString().trim().toUpperCase()));
  const checkOutIdx = headers.findIndex(h => h && ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT', 'CHECK OUT DATE', 'CHECK-OUT DATE'].includes(h.toString().trim().toUpperCase()));
  const roomIdx     = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');
  const roomPaxIdx  = headers.findIndex(h => h && ['ROOM_PAX', 'ROOM PAX'].includes(h.toString().trim().toUpperCase()));

  for (let i = startIdx; i < rows.length; i++) {
    const item = rows[i];
    const row = (item && Array.isArray(item.row)) ? item.row : item;

    if (!row || !Array.isArray(row) || row.slice(0, -1).every(cell => !cell || cell.toString().trim() === '')) {
      continue;
    }

    const remarkIdx = headers.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
    const specialReqIdx = headers.findIndex(h => h && ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'SPECIAL REQUESTS', 'REQUEST'].includes(h.toString().trim().toUpperCase()));
    const remarkVal = remarkIdx !== -1 ? (row[remarkIdx] || '') : '';
    const specialReqVal = specialReqIdx !== -1 ? (row[specialReqIdx] || '') : '';

    const combinedVal = `${remarkVal} ${specialReqVal}`.trim();
    const lowerRemark = combinedVal.toLowerCase();
    const isSpecialRemark = isSpecialRemarkText(combinedVal);
    const isHistorical = lowerRemark.includes('previously') || lowerRemark.includes('prev');
    if (isSpecialRemark && !isHistorical) continue;

    try {
      const code  = codeIdx !== -1 ? (row[codeIdx] || '').toString().trim() : '';
      const name  = nameIdx !== -1 ? (row[nameIdx] || '').toString().trim() : '';
      const roomRaw = roomIdx !== -1 ? (row[roomIdx] || '').toString().trim() : '';
      const fallbackPax = roomPaxIdx !== -1 ? parseInt(row[roomPaxIdx], 10) : 1;

      const checkInRaw  = checkInIdx  !== -1 ? (row[checkInIdx]  || '').toString().trim() : '';
      const checkOutRaw = checkOutIdx !== -1 ? (row[checkOutIdx] || '').toString().trim() : '';

      const checkInDate  = parseDate(checkInRaw);
      const checkOutDate = parseDate(checkOutRaw);

      if (!checkInDate && !checkOutDate) continue;

      const roomAllocations = parseRoomString(roomRaw, fallbackPax);
      if (roomAllocations.length === 0) continue;

      // When a booking has a single room assigned, use the row's actual guest count
      const rowGuestCount = getRowGuestCount(row, headers);
      if (rowGuestCount > 0 && roomAllocations.length === 1) {
        roomAllocations[0].pax = rowGuestCount;
      }

      const isTransition = roomAllocations.some(r => r.isTransition);

      // Handle mid-stay room transitions: "D105 ➔ D106 (Changed on 15 Sept)"
      if (isTransition && roomAllocations.length >= 2) {
        const changeDateMatch = roomRaw.match(/Changed\s+on\s+([^)]+)/i);
        let changeDate = null;
        if (changeDateMatch) {
          changeDate = parseDate(changeDateMatch[1].trim());
        }

        const room1 = roomAllocations[0];
        const room2 = roomAllocations[1];

        // 1. Initial Check-In date: room1 check-in
        if (checkInDate) {
          const inKey = toKLDateString(checkInDate);
          const dayBucket = dayDateMap.get(inKey);
          if (dayBucket && (filterType === 'both' || filterType === 'checkin')) {
            dayBucket.checkIns.push({
              room: room1.room,
              pax: room1.pax,
              isShared: room1.isShared,
              code,
              name,
            });
          }
        }

        // 2. Room Change Date: room1 check-out, room2 check-in
        if (changeDate) {
          const changeKey = toKLDateString(changeDate);
          const dayBucket = dayDateMap.get(changeKey);
          if (dayBucket) {
            if (filterType === 'both' || filterType === 'checkout') {
              dayBucket.checkOuts.push({
                room: room1.room,
                pax: room1.pax,
                isShared: room1.isShared,
                code,
                name,
                isRoomMove: true,
              });
            }
            if (filterType === 'both' || filterType === 'checkin') {
              dayBucket.checkIns.push({
                room: room2.room,
                pax: room2.pax,
                isShared: room2.isShared,
                code,
                name,
                isRoomMove: true,
              });
            }
          }
        }

        // 3. Final Check-Out date: room2 check-out
        if (checkOutDate) {
          const outKey = toKLDateString(checkOutDate);
          const dayBucket = dayDateMap.get(outKey);
          if (dayBucket && (filterType === 'both' || filterType === 'checkout')) {
            dayBucket.checkOuts.push({
              room: room2.room,
              pax: room2.pax,
              isShared: room2.isShared,
              code,
              name,
            });
          }
        }

        continue;
      }

      // Standard non-transition bookings:
      // Process Check-Out:
      if (checkOutDate && (filterType === 'both' || filterType === 'checkout')) {
        const outKey = toKLDateString(checkOutDate);
        const dayBucket = dayDateMap.get(outKey);
        if (dayBucket) {
          for (const alloc of roomAllocations) {
            dayBucket.checkOuts.push({
              room: alloc.room,
              pax: alloc.pax,
              isShared: alloc.isShared,
              code,
              name,
            });
          }
        }
      }

      // Process Check-In:
      if (checkInDate && (filterType === 'both' || filterType === 'checkin')) {
        const inKey = toKLDateString(checkInDate);
        const dayBucket = dayDateMap.get(inKey);
        if (dayBucket) {
          for (const alloc of roomAllocations) {
            dayBucket.checkIns.push({
              room: alloc.room,
              pax: alloc.pax,
              isShared: alloc.isShared,
              code,
              name,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Error processing row ${i} for housekeeping:`, err.message);
    }
  }

  // Post-processing for each day:
  // 1. Combine entries for identical rooms (e.g. multiple bookings in D105)
  // 2. Identify back-to-back (b2b) rooms
  // 3. Sort rooms according to policy
  let totalCheckOuts = 0;
  let totalCheckIns = 0;
  let totalB2B = 0;

  for (const day of days) {
    // 1. Combine duplicate room entries by summing pax
    day.checkOuts = aggregateRoomList(day.checkOuts);
    day.checkIns = aggregateRoomList(day.checkIns);

    // 2. Collect all room codes checking in today
    const checkInRoomSet = new Set(day.checkIns.map(c => c.room));

    // 3. Tag b2b on check-out rooms that also check in today
    day.checkOuts.forEach(c => {
      c.b2b = checkInRoomSet.has(c.room);
    });

    // 4. Count metrics
    totalCheckOuts += day.checkOuts.length;
    totalCheckIns += day.checkIns.length;
    totalB2B += day.checkOuts.filter(c => c.b2b).length;

    // 5. Sorting
    if (sortBy === 'b2bFirst') {
      day.checkOuts.sort((a, b) => {
        if (a.b2b !== b.b2b) return a.b2b ? -1 : 1;
        return compareRooms(a, b);
      });
    } else {
      // Natural room ordering
      day.checkOuts.sort(compareRooms);
    }

    day.checkIns.sort(compareRooms);
  }

  const now = new Date();
  const generatedAt = now.toLocaleString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: KL_TIMEZONE,
  });

  return {
    startDateStr,
    endDateStr,
    filterType,
    generatedAt,
    days,
    summary: {
      totalCheckOuts,
      totalCheckIns,
      totalB2B,
    },
  };
}

/**
 * Formats a single day into the Reception Housekeeping message string.
 *
 * Example Output:
 * *Check out 11/10*
 * * D105 - 6 b2b
 * * H108
 * * D104 b2b
 * * V102
 *
 * *Check in*
 * * B109 - 4
 * * D105 - 1
 * * D104 - 2
 *
 * @param {Object} day
 * @param {Object} options - { format: 'whatsapp' | 'telegramHtml' }
 * @returns {string}
 */
function formatHousekeepingDayMessage(day, options = {}) {
  const format = options.format || 'whatsapp';
  const lines = [];

  const dayMonth = day.dayMonth; // e.g. "11/10"

  // 1. Header & Check-Out Section
  if (format === 'telegramHtml') {
    lines.push(`<b>Check out ${dayMonth}</b>`);
  } else {
    lines.push(`*Check out ${dayMonth}*`);
  }

  if (day.checkOuts.length > 0) {
    for (const c of day.checkOuts) {
      let line = `* ${c.room}`;
      // Rule: ONLY shared rooms (D105 & D106) show pax on checkout
      if (c.isShared && c.pax > 0) {
        line += ` - ${c.pax}`;
      }
      if (c.b2b) {
        line += ' b2b';
      }
      lines.push(line);
    }
  } else {
    lines.push(format === 'telegramHtml' ? '<b>Belum ada Check out</b>' : '*Belum ada Check out*');
  }

  lines.push(''); // Blank line separator

  // 2. Check-In Section
  if (format === 'telegramHtml') {
    lines.push(`<b>Check in</b>`);
  } else {
    lines.push(`*Check in*`);
  }

  if (day.checkIns.length > 0) {
    for (const c of day.checkIns) {
      // Check-in ALWAYS includes pax: "* <Room> - <Pax>"
      const paxCount = c.pax > 0 ? c.pax : 1;
      lines.push(`* ${c.room} - ${paxCount}`);
    }
  } else {
    // Replace section with empty notice if no arrivals
    lines.pop(); // Remove "*Check in*"
    lines.push(format === 'telegramHtml' ? '<b>Belum ada Check in</b>' : '*Belum ada Check in*');
  }

  let result = lines.join('\n').trim();
  if (options.includeTimestamp) {
    result = appendHousekeepingTimestamp(result, options.now || new Date(), format);
  }
  return result;
}

/**
 * Append a last-updated timestamp footer to a housekeeping day message.
 * Modeled after Boat Transfer report: "Last updated: 03:15 PM, 11/10"
 *
 * @param {string} text - The formatted message string
 * @param {Date}   now  - Timestamp date object (default: current date/time)
 * @param {string} format - 'telegramHtml' or 'whatsapp'
 * @returns {string} Text with last updated footer
 */
function appendHousekeepingTimestamp(text, now = new Date(), format = 'whatsapp') {
  const timeString = now.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: KL_TIMEZONE,
  });

  const dateString = now.toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    timeZone: KL_TIMEZONE,
  });

  if (format === 'telegramHtml') {
    return `${text}\n\n<i>Last updated: ${timeString}, ${dateString}</i>`;
  }
  return `${text}\n\n_Last updated: ${timeString}, ${dateString}_`;
}

/**
 * Auto-sends and auto-updates the Housekeeping Room List report on Telegram.
 * Mirrors sendWeeklyReport: updates existing date messages in-place via editMessageText,
 * or sends new messages via sendMessage.
 *
 * @param {Array[]} rows - Enriched sheet rows
 * @param {string}  chatId - Target Telegram chat ID
 * @param {string}  reason - 'scheduled', 'updated', or 'manual'
 * @param {object}  prevMessages - Previous report messages { dateMessages: { "YYYY-MM-DD": msgId }, dateHashes: { "YYYY-MM-DD": hash } }
 * @param {string[]} changedDates - Array of date strings that specifically changed
 * @returns {Promise<{ report, messages: { dateMessages, dateHashes } }>}
 */
async function sendHousekeepingAutoReport(rows, chatId, reason = 'scheduled', prevMessages = null, changedDates = []) {
  const crypto = require('crypto');
  const { sendMessage, editMessageText } = require('./telegram');

  // Build report for the 10-day forward window (today to today + 9 days)
  const now = new Date();
  const startStr = toKLDateString(now);
  const endKL = getKLDate(now);
  const endJsDate = new Date(endKL.year, endKL.month, endKL.day + 9);
  const endStr = toKLDateString(endJsDate);

  const report = buildHousekeepingReport(rows, {
    startDateStr: startStr,
    endDateStr: endStr,
    filterType: 'both',
    sortBy: 'natural',
  });

  const dateMessages = { ...(prevMessages?.dateMessages || {}) };
  const dateHashes = { ...(prevMessages?.dateHashes || {}) };

  // Clean up stale date keys no longer in the window
  const currentWindowDates = new Set(report.days.map(d => d.dateStr));
  for (const key of Object.keys(dateMessages)) {
    if (!currentWindowDates.has(key)) delete dateMessages[key];
  }
  for (const key of Object.keys(dateHashes)) {
    if (!currentWindowDates.has(key)) delete dateHashes[key];
  }

  for (const day of report.days) {
    const dateStr = day.dateStr;
    // Calculate hash on base message without timestamp so edits only happen when content changes
    const baseMsg = formatHousekeepingDayMessage(day, { format: 'telegramHtml' });
    const hash = crypto.createHash('md5').update(baseMsg).digest('hex');

    const prevMsgId = prevMessages?.dateMessages?.[dateStr];
    const prevHash = prevMessages?.dateHashes?.[dateStr];

    const hasChanged = (prevHash !== hash) || (Array.isArray(changedDates) && changedDates.includes(dateStr));
    const needsSending = !prevMsgId || hasChanged;

    if (needsSending) {
      // Append the latest timestamp when sending / updating
      const msgText = appendHousekeepingTimestamp(baseMsg, now, 'telegramHtml');

      if (prevMsgId) {
        console.log(`   ✏️ [HK Auto] Editing housekeeping message for ${dateStr} (ID: ${prevMsgId})`);
        try {
          const edited = await editMessageText(chatId, prevMsgId, msgText);
          if (edited) {
            dateMessages[dateStr] = prevMsgId;
            dateHashes[dateStr] = hash;
          } else {
            const newMsgId = await sendMessage(msgText, null, chatId);
            if (newMsgId) {
              dateMessages[dateStr] = newMsgId;
              dateHashes[dateStr] = hash;
            }
          }
        } catch (err) {
          if (err.message && err.message.includes('message is not modified')) {
            dateMessages[dateStr] = prevMsgId;
            dateHashes[dateStr] = prevHash;
          } else {
            console.warn(`   ⚠️ [HK Auto] Failed to edit message for ${dateStr}, sending new:`, err.message);
            const newMsgId = await sendMessage(msgText, null, chatId);
            if (newMsgId) {
              dateMessages[dateStr] = newMsgId;
              dateHashes[dateStr] = hash;
            }
          }
        }
      } else {
        console.log(`   📨 [HK Auto] Sending new housekeeping message for ${dateStr}`);
        const newMsgId = await sendMessage(msgText, null, chatId);
        if (newMsgId) {
          dateMessages[dateStr] = newMsgId;
          dateHashes[dateStr] = hash;
        }
      }
    } else {
      dateMessages[dateStr] = prevMsgId;
      dateHashes[dateStr] = prevHash;
    }
  }

  return {
    report,
    messages: {
      dateMessages,
      dateHashes,
    },
  };
}

module.exports = {
  SHARED_ROOM_CODES,
  isSharedRoom,
  normalizeRoomCode,
  parseRoomString,
  compareRooms,
  buildHousekeepingReport,
  formatHousekeepingDayMessage,
  appendHousekeepingTimestamp,
  appendTimestamp: appendHousekeepingTimestamp,
  sendHousekeepingAutoReport,
  aggregateRoomList,
  getRowGuestCount,
  toKLDateString,
  formatDayMonth,
};
