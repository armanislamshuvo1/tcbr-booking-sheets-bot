const fs = require('fs');
const path = require('path');
const { getDbStatus, getDb } = require('./snapshot');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OVERRIDES_FILE = path.join(DATA_DIR, 'booking_overrides.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let cachedOverrides = null;
let lastOverridesLoadTime = 0;
const CACHE_TTL = 300000; // 5 minutes cache

/**
 * Load all active booking overrides.
 * Returns an object map: { [bookingKey]: overrideDataObject }
 */
async function loadOverrides(force = false) {
  const now = Date.now();
  if (!force && cachedOverrides && (now - lastOverridesLoadTime < CACHE_TTL)) {
    return cachedOverrides;
  }

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('booking_overrides');
      const docs = await collection.find({}).toArray();
      const map = {};
      docs.forEach(doc => {
        const { _id, bookingKey, ...data } = doc;
        map[bookingKey] = data;
      });
      cachedOverrides = map;
      lastOverridesLoadTime = now;
      return map;
    } catch (err) {
      console.error('   ❌ MongoDB loadOverrides error:', err.message);
    }
  }

  if (!fs.existsSync(OVERRIDES_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
    cachedOverrides = data;
    lastOverridesLoadTime = now;
    return data;
  } catch {
    return {};
  }
}

/**
 * Save an override for a specific booking key.
 * @param {string} bookingKey - Unique identifier (e.g. CODE or row key)
 * @param {object} overrideData - Key-value pair of edited column values
 * @param {string} updatedBy - Username of admin who edited
 */
async function saveOverride(bookingKey, overrideData, updatedBy) {
  if (!bookingKey) throw new Error('Booking key is required');

  const overrides = await loadOverrides(true);
  const payload = {
    ...overrideData,
    isOverridden: true,
    updatedBy: updatedBy || 'Admin',
    updatedAt: new Date().toISOString()
  };

  overrides[bookingKey] = payload;
  cachedOverrides = overrides;
  lastOverridesLoadTime = Date.now();

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('booking_overrides');
      await collection.updateOne(
        { bookingKey },
        { $set: { bookingKey, ...payload } },
        { upsert: true }
      );
    } catch (err) {
      console.error('   ❌ MongoDB saveOverride error:', err.message);
    }
  }

  try {
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf-8');
  } catch (err) {
    console.error('   ❌ File saveOverride error:', err.message);
  }

  return payload;
}

/**
 * Remove an override for a booking key (revert to original sheet data).
 * Supports search by key, ROW_rowIndex, or legacy keys.
 */
async function deleteOverride(bookingKey, rowIndex) {
  const overrides = await loadOverrides(true);

  let targetKey = null;

  // Extract numeric row index if passed as ROW_X or string
  let parsedRowIndex = rowIndex;
  if ((parsedRowIndex === undefined || parsedRowIndex === null || isNaN(parsedRowIndex)) && bookingKey && typeof bookingKey === 'string') {
    if (bookingKey.startsWith('ROW_')) {
      const idx = parseInt(bookingKey.replace('ROW_', ''), 10);
      if (!isNaN(idx)) parsedRowIndex = idx;
    } else if (bookingKey.includes('_ROW_')) {
      const parts = bookingKey.split('_ROW_');
      const idx = parseInt(parts[1], 10);
      if (!isNaN(idx)) parsedRowIndex = idx;
    }
  }

  // 1. Direct match by bookingKey
  if (bookingKey && overrides && overrides[bookingKey]) {
    targetKey = bookingKey;
  }
  // 2. Direct match by ROW_rowIndex
  else if (parsedRowIndex !== undefined && parsedRowIndex !== null && !isNaN(parsedRowIndex) && overrides && overrides[`ROW_${parsedRowIndex}`]) {
    targetKey = `ROW_${parsedRowIndex}`;
  }
  // 3. Fallback search across overrides map
  else if (overrides) {
    for (const k in overrides) {
      if (
        k === bookingKey ||
        (parsedRowIndex !== undefined && !isNaN(parsedRowIndex) && (k === `ROW_${parsedRowIndex}` || k.endsWith(`_ROW_${parsedRowIndex}`))) ||
        (bookingKey && overrides[k]?.fields?.CODE === bookingKey) ||
        (bookingKey && k.includes(bookingKey))
      ) {
        targetKey = k;
        break;
      }
    }
  }

  // 4. Fallback if single override exists
  if (!targetKey && bookingKey && overrides) {
    const keys = Object.keys(overrides);
    if (keys.length === 1) {
      targetKey = keys[0];
    }
  }

  let removed = false;

  if (targetKey && overrides) {
    delete overrides[targetKey];
    try {
      fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf-8');
    } catch (err) {
      console.error('   ❌ File deleteOverride error:', err.message);
    }
    removed = true;
  }

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('booking_overrides');
      const deleteConditions = [];
      if (targetKey) deleteConditions.push({ bookingKey: targetKey });
      if (bookingKey) deleteConditions.push({ bookingKey });
      if (parsedRowIndex !== undefined && !isNaN(parsedRowIndex)) {
        deleteConditions.push({ bookingKey: `ROW_${parsedRowIndex}` });
      }
      if (deleteConditions.length > 0) {
        const dbRes = await collection.deleteMany({ $or: deleteConditions });
        if (dbRes.deletedCount > 0) {
          removed = true;
        }
      }
    } catch (err) {
      console.error('   ❌ MongoDB deleteOverride error:', err.message);
    }
  }

  // Reset in-memory cache to ensure fresh state on next read
  cachedOverrides = null;
  lastOverridesLoadTime = 0;

  return removed;
}

const HEADER_ALIASES = {
  'SNORKELLING': ['SNORKELING', 'SNORKELLING', 'SNORKEL'],
  'SNORKELING': ['SNORKELING', 'SNORKELLING', 'SNORKEL'],
  'DIVING': ['DIVING', 'DIVE'],
  'COURSE': ['COURSE', 'COURSES'],
  'CHECK IN': ['CHECK IN', 'CHECK-IN', 'CHECKIN'],
  'CHECK OUT': ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'],
  'REMARK': ['REMARK', 'REMARKS'],
  'ROOM_PAX': ['ROOM_PAX', 'ROOM PAX'],
  'TOTAL AMOUNT': ['TOTAL AMOUNT', 'TOTAL'],
  'PIC': ['PIC', 'PERSON IN CHARGE'],
  'STAYING DAYS': ['STAYING DAYS', 'DAYS', 'STAY DURATION'],
  'ROOM TYPE': ['ROOM TYPE', 'ROOM_TYPE', 'ROOMTYPE'],
  'SPECIAL REQUEST': ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'REQUEST'],
  'GUEST_PAX': ['GUEST_PAX', 'GUESTS', 'PAX'],
};

const FIXED_COLUMN_INDEX_MAPPINGS = {
  1: ['CODE'],
  2: ['PIC', 'PERSON IN CHARGE'],
  3: ['NAME', 'CUSTOMER NAME'],
  4: ['SNORKELLING', 'SNORKELING', 'SNORKEL'],
  5: ['DIVING', 'DIVE'],
  6: ['COURSE', 'COURSES'],
  7: ['CHECK IN', 'CHECK-IN', 'CHECKIN'],
  8: ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'],
  9: ['STAYING DAYS', 'DAYS', 'STAY DURATION'],
  10: ['ROOM TYPE', 'ROOM_TYPE', 'ROOMTYPE'],
  11: ['SHARING'],
  12: ['BED'],
  13: ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'REQUEST'],
  18: ['TOTAL AMOUNT', 'TOTAL'],
  19: ['DEPOSIT'],
  20: ['BALANCE'],
  21: ['STATUS'],
  22: ['REMARK', 'REMARKS'],
};

function getOverriddenValue(overrideFields, headerName) {
  if (!overrideFields || !headerName) return undefined;
  const norm = headerName.toString().trim().toUpperCase();
  if (overrideFields[norm] !== undefined) return overrideFields[norm];

  const aliases = HEADER_ALIASES[norm];
  if (aliases) {
    for (const alias of aliases) {
      if (overrideFields[alias] !== undefined) {
        return overrideFields[alias];
      }
    }
  }
  return undefined;
}

/**
 * Helper to get unique key for a row.
 * Ties override strictly to the row's unique index to prevent duplicate cards.
 */
function getBookingKey(row, headers, rowIndex) {
  if (rowIndex !== undefined && rowIndex !== null) {
    return `ROW_${rowIndex}`;
  }
  return `ROW_0`;
}

/**
 * Applies active overrides onto a list of row objects or raw row arrays.
 * Returns enriched rows array with override values merged in.
 */
async function applyOverridesToRows(bookingEntries, headers, explicitOverrides = null) {
  const overrides = explicitOverrides || await module.exports.loadOverrides();
  if (!overrides || Object.keys(overrides).length === 0) {
    return bookingEntries;
  }

  return bookingEntries.map(entry => {
    // Handle both raw row array and object { row, rowIndex } formats
    const isObject = typeof entry === 'object' && entry !== null && Array.isArray(entry.row);
    const row = isObject ? [...entry.row] : (Array.isArray(entry) ? [...entry] : entry);
    const rowIndex = isObject ? entry.rowIndex : undefined;

    if (rowIndex === undefined || rowIndex === null) {
      return entry;
    }

    const bookingKey = `ROW_${rowIndex}`;
    const override = overrides[bookingKey];

    if (!override) return entry;

    // Clone row array so we don't mutate original reference directly
    const mergedRow = [...row];

    // Merge overridden fields matching headers and aliases
    if (headers && Array.isArray(headers)) {
      headers.forEach((headerName, colIdx) => {
        let val;
        if (headerName) {
          val = getOverriddenValue(override.fields, headerName);
        }
        // Fallback for merged columns where headerName is empty in headers array
        if (val === undefined && FIXED_COLUMN_INDEX_MAPPINGS[colIdx]) {
          for (const alias of FIXED_COLUMN_INDEX_MAPPINGS[colIdx]) {
            if (override.fields && override.fields[alias] !== undefined && override.fields[alias] !== '') {
              val = override.fields[alias];
              break;
            }
          }
        }
        if (val !== undefined) {
          mergedRow[colIdx] = val;
        }
      });
    }

    // Direct fallback for fixed column indices if row length allows
    for (const [colIdxStr, fieldAliases] of Object.entries(FIXED_COLUMN_INDEX_MAPPINGS)) {
      const colIdx = parseInt(colIdxStr, 10);
      if (mergedRow.length > colIdx) {
        for (const alias of fieldAliases) {
          if (override.fields && override.fields[alias] !== undefined && override.fields[alias] !== '') {
            mergedRow[colIdx] = override.fields[alias];
            break;
          }
        }
      }
    }

    if (isObject) {
      const resEntry = {
        ...entry,
        row: mergedRow,
        isOverridden: true,
        overrideMeta: {
          updatedBy: override.updatedBy,
          updatedAt: override.updatedAt,
          bookingKey
        }
      };
      if (override.fields?.GUEST_PAX) {
        const p = parseInt(override.fields.GUEST_PAX, 10);
        if (!isNaN(p) && p > 0) resEntry.pax = p;
      }
      return resEntry;
    } else if (Array.isArray(entry)) {
      // Attach non-enumerable properties or wrapper metadata if needed
      mergedRow.isOverridden = true;
      mergedRow.overrideMeta = {
        updatedBy: override.updatedBy,
        updatedAt: override.updatedAt,
        bookingKey
      };
      return mergedRow;
    }

    return entry;
  });
}

module.exports = {
  loadOverrides,
  saveOverride,
  deleteOverride,
  getBookingKey,
  applyOverridesToRows
};
