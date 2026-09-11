/**
 * Change detection logic.
 *
 * The sheet layout:
 *   Row 0   = Header row  (skipped)
 *   Col H   = Check-in Date  (index 7)
 *   Col I   = Check-out Date (index 8)
 *
 * A row is considered "current month" if the check-in date
 * falls within the current month & year.
 */

const CHECK_IN_COL  = 7; // Column H (0-indexed)
const CHECK_OUT_COL = 8; // Column I (0-indexed)

/**
 * Helper to get English month name from a text string case-insensitively.
 * Supports typos and abbreviations.
 */
function getMonthNameFromText(text) {
  const index = getMonthIndexFromText(text);
  if (index === -1) return null;
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return MONTH_NAMES[index];
}

/**
 * Helper to get 0-indexed month number from a text string case-insensitively.
 */
function getMonthIndexFromText(text) {
  if (!text || typeof text !== 'string') return -1;
  const lower = text.toLowerCase();
  if (lower.includes('jan')) return 0;
  if (lower.includes('feb')) return 1;
  if (lower.includes('mar')) return 2; // matches march, marc, marcj
  if (lower.includes('apr')) return 3;
  if (lower.includes('may')) return 4;
  if (lower.includes('jun')) return 5;
  if (lower.includes('jul')) return 6;
  if (lower.includes('aug')) return 7;
  if (lower.includes('sep')) return 8; // matches sept, september
  if (lower.includes('oct')) return 9;
  if (lower.includes('nov')) return 10;
  if (lower.includes('dec')) return 11;
  return -1;
}

/**
 * Parse a date string in common formats like:
 *   "10/06/2026", "2026-06-10", "June 10, 2026", "10-Jun-2026", etc.
 * Returns a Date object or null if unparseable.
 */
function parseDate(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // 1. Try standard YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
  const ymdMatch = trimmed.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (ymdMatch) {
    const [, year, month, day] = ymdMatch;
    const d = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
    if (!isNaN(d)) return d;
  }

  // 2. Try DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmy4Match = trimmed.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy4Match) {
    const [, day, month, year] = dmy4Match;
    const d = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
    if (!isNaN(d)) return d;
  }

  // 3. Try DD/MM/YY or DD-MM-YY or DD.MM.YY (2-digit year)
  const dmy2Match = trimmed.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (dmy2Match) {
    const [, day, month, year2] = dmy2Match;
    const year = 2000 + parseInt(year2, 10); // Assume 20xx
    const d = new Date(year, parseInt(month, 10) - 1, parseInt(day, 10));
    if (!isNaN(d)) return d;
  }

  // 4. Try DD/MM or DD-MM or DD.MM (no year)
  const dmMatch = trimmed.match(/^(\d{1,2})[\/\-\.](\d{1,2})$/);
  if (dmMatch) {
    const [, day, month] = dmMatch;
    const year = new Date().getFullYear();
    const d = new Date(year, parseInt(month, 10) - 1, parseInt(day, 10));
    if (!isNaN(d)) return d;
  }

  // 5. Try native parse for textual dates with explicit year (e.g. "June 10, 2026")
  if (/\b(19|20)\d{2}\b/.test(trimmed)) {
    const nativeDate = new Date(trimmed);
    if (!isNaN(nativeDate) && !/^\d+$/.test(trimmed)) {
      return nativeDate;
    }
  }

  // 6. Handle textual formats with ordinal suffixes and typos (e.g. "20th March", "2nd June", "24thJuly", "17th Marcj")
  const dayMatch = trimmed.match(/^(\d+)/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    const month = getMonthIndexFromText(trimmed);
    if (month !== -1) {
      const now = new Date();
      const year = now.getFullYear();
      const parsed = new Date(year, month, day);
      if (!isNaN(parsed)) return parsed;
    }
  }

  return null;
}

/**
 * Check if a date falls within the target month & year (defaults to current month & year).
 * @param {Date} date - Date object to check
 * @param {Date} [referenceDate] - Optional reference date to compare against (defaults to now)
 */
function isCurrentMonth(date, referenceDate = new Date()) {
  if (!date || isNaN(date.getTime())) return false;
  return date.getFullYear() === referenceDate.getFullYear() &&
         date.getMonth()    === referenceDate.getMonth();
}

/**
 * Check if a booking falls within or overlaps with the target month (defaults to current month).
 * A booking qualifies if:
 * 1. Check-in date is in the month, OR
 * 2. Check-out date is in the month (e.g. 30 Aug to 2nd Sept departing in Sept), OR
 * 3. The stay interval spans across the month (checkIn <= endOfMonth && checkOut >= startOfMonth).
 * 
 * @param {Date|null} checkIn - Parsed check-in date
 * @param {Date|null} checkOut - Parsed check-out date
 * @param {Date} [referenceDate] - Optional reference date (defaults to now)
 */
function isBookingInCurrentMonth(checkIn, checkOut, referenceDate = new Date()) {
  const validCheckIn = (checkIn && !isNaN(checkIn.getTime())) ? checkIn : null;
  const validCheckOut = (checkOut && !isNaN(checkOut.getTime())) ? checkOut : null;

  if (!validCheckIn && !validCheckOut) return false;

  // 1. Check-in falls in the month
  if (validCheckIn && isCurrentMonth(validCheckIn, referenceDate)) return true;

  // 2. Check-out falls in the month (e.g. cross-month stays departing this month)
  if (validCheckOut && isCurrentMonth(validCheckOut, referenceDate)) return true;

  // 3. Stay spans across the month
  if (validCheckIn && validCheckOut) {
    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth();
    const startOfMonth = new Date(year, month, 1, 0, 0, 0, 0);
    const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59, 999);

    if (validCheckIn <= endOfMonth && validCheckOut >= startOfMonth) {
      return true;
    }
  }

  return false;
}

/**
 * Generate a stable unique key for a row.
 * Uses the first non-empty cell (usually an ID or name) + row index as fallback.
 */
function rowKey(row, rowIndex) {
  const firstCell = (row[0] || '').toString().trim();
  return firstCell ? `${firstCell}__row${rowIndex}` : `row${rowIndex}`;
}

/**
 * Find the index of the header row in the spreadsheet.
 * Typically the row that contains critical column identifiers like 'CODE'.
 */
function findHeaderRowIndex(rows) {
  if (!rows || !Array.isArray(rows)) return 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const item = rows[i];
    const row = (item && Array.isArray(item.row)) ? item.row : item;
    if (row && Array.isArray(row) && row.some(cell => typeof cell === 'string' && cell.trim().toUpperCase() === 'CODE')) {
      return i;
    }
  }
  return 0; // Default to row 0 if not found
}


/**
 * Build a map of { rowKey -> { row, checkIn, checkOut, rowIndex } }
 * for all rows that belong to or overlap with the current month.
 */
function buildCurrentMonthMap(rows, referenceDate = new Date()) {
  const map = {};
  const headerIndex = findHeaderRowIndex(rows);

  // Skip header row
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const checkIn  = parseDate(row[CHECK_IN_COL]);
    const checkOut = parseDate(row[CHECK_OUT_COL]);

    if (isBookingInCurrentMonth(checkIn, checkOut, referenceDate)) {
      const key = rowKey(row, i);
      map[key] = { row, checkIn, checkOut, rowIndex: i };
    }
  }

  return map;
}

/**
 * Main change detection function.
 *
 * @param {Array[]} rows          - Current rows from the sheet (with header at [0])
 * @param {Object}  prevSnapshot  - Previous snapshot: { headers, monthMap }
 * @returns {{ newRows, modifiedRows, currentMonthRows }}
 */
function detectChanges(rows, prevSnapshot) {
  const headerIndex = findHeaderRowIndex(rows);
  const headers = rows[headerIndex] || [];
  const currentMap = buildCurrentMonthMap(rows);
  const currentMonthRows = Object.values(currentMap);

  const newRows = [];
  const modifiedRows = [];

  const prevMap = prevSnapshot?.monthMap || {};

  for (const [key, current] of Object.entries(currentMap)) {
    if (!prevMap[key]) {
      // Row is brand new this month
      newRows.push({ key, ...current, headers });
    } else {
      // Row existed before — check if any cell changed
      const prevRow = prevMap[key].row;
      const currRow = current.row;
      const changes = [];

      const maxLen = Math.max(prevRow.length, currRow.length);
      for (let col = 0; col < maxLen; col++) {
        const before = (prevRow[col] || '').toString().trim();
        const after  = (currRow[col] || '').toString().trim();
        if (before !== after) {
          const colName = headers[col] || `Col ${col + 1}`;
          const colUpper = colName.toString().toUpperCase().trim();
          // Exclude payment details columns from change detection
          if (['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS'].includes(colUpper)) {
            continue;
          }
          changes.push({
            column: colName,
            before,
            after,
          });
        }
      }

      if (changes.length > 0) {
        modifiedRows.push({ key, ...current, headers, changes });
      }
    }
  }

  return { newRows, modifiedRows, currentMonthRows };
}

function getStayDays(checkInStr, checkOutStr) {
  const checkInDate = parseDate(checkInStr);
  const checkOutDate = parseDate(checkOutStr);
  if (!checkInDate) return [];

  const days = [];
  const start = new Date(checkInDate);
  const end = checkOutDate ? new Date(checkOutDate) : new Date(checkInDate);

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  if (!checkOutDate || end <= start) {
    const monthName = MONTH_NAMES[start.getMonth()];
    days.push({ day: start.getDate(), month: monthName.toUpperCase() });
    return days;
  }

  let current = new Date(start);
  while (current < end) {
    const monthName = MONTH_NAMES[current.getMonth()];
    days.push({ day: current.getDate(), month: monthName.toUpperCase() });
    current.setDate(current.getDate() + 1);
  }

  return days;
}

module.exports = { detectChanges, buildCurrentMonthMap, parseDate, isCurrentMonth, isBookingInCurrentMonth, rowKey, findHeaderRowIndex, getMonthNameFromText, getMonthIndexFromText, getStayDays };
