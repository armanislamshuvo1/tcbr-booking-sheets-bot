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
  const existing = overrides[bookingKey] || {};
  const mergedFields = {
    ...(existing.fields || {}),
    ...(overrideData && overrideData.fields ? overrideData.fields : {})
  };
  const payload = {
    ...existing,
    ...overrideData,
    fields: mergedFields,
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
  'SHARING': ['SHARING', 'ROOM SHARING'],
  'BED': ['BED', 'BED TYPE', 'BEDDING'],
  'SPECIAL REQUEST': ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'REQUEST'],
  'GUEST_PAX': ['GUEST_PAX', 'GUESTS', 'PAX'],
  'PHONE': ['PHONE', 'CONTACT', 'WHATSAPP', 'MOBILE', 'TEL', 'PHONE NUMBER', 'CONTACT NUMBER', 'HP', 'HANDPHONE'],
  'CONTACT': ['PHONE', 'CONTACT', 'WHATSAPP', 'MOBILE', 'TEL', 'PHONE NUMBER', 'CONTACT NUMBER', 'HP', 'HANDPHONE'],
  'WHATSAPP': ['PHONE', 'CONTACT', 'WHATSAPP', 'MOBILE', 'TEL', 'PHONE NUMBER', 'CONTACT NUMBER', 'HP', 'HANDPHONE'],
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
  11: ['SHARING', 'ROOM SHARING'],
  12: ['BED', 'BED TYPE', 'BEDDING'],
  13: ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'REQUEST'],
  18: ['TOTAL AMOUNT', 'TOTAL'],
  19: ['DEPOSIT'],
  20: ['BALANCE'],
  21: ['STATUS'],
  22: ['REMARK', 'REMARKS'],
};

const NON_EMPTY_ONLY_HEADERS = new Set([
  'TOTAL AMOUNT', 'TOTAL', 'DEPOSIT', 'BALANCE', 'STATUS', 'ROOM', 'ROOM_PAX'
]);

function getOverriddenValue(overrideFields, headerName) {
  if (!overrideFields || !headerName) return undefined;
  const norm = headerName.toString().trim().toUpperCase();
  const requireNonEmpty = NON_EMPTY_ONLY_HEADERS.has(norm);

  if (overrideFields[norm] !== undefined) {
    if (!requireNonEmpty || String(overrideFields[norm]).trim() !== '') {
      return overrideFields[norm];
    }
  }

  const aliases = HEADER_ALIASES[norm];
  if (aliases) {
    for (const alias of aliases) {
      if (overrideFields[alias] !== undefined) {
        if (!requireNonEmpty || String(overrideFields[alias]).trim() !== '') {
          return overrideFields[alias];
        }
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
 * Attaches non-enumerable metadata onto a row array so array consumers (like saveSnapshot) preserve it.
 */
function attachRowMeta(rowArr, meta = {}) {
  if (!Array.isArray(rowArr)) return rowArr;
  if (meta.inheritedMeta !== undefined) {
    Object.defineProperty(rowArr, '_inheritedMeta', {
      value: meta.inheritedMeta,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (meta.isCustomBooking !== undefined) {
    Object.defineProperty(rowArr, '_isCustomBooking', {
      value: !!meta.isCustomBooking,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (meta.customRowIndex !== undefined) {
    Object.defineProperty(rowArr, '_customRowIndex', {
      value: meta.customRowIndex,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  return rowArr;
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
    const origRow = isObject ? entry.row : (Array.isArray(entry) ? entry : null);
    const row = origRow ? [...origRow] : entry;
    const rowIndex = isObject ? entry.rowIndex : (origRow && origRow._customRowIndex !== undefined ? origRow._customRowIndex : undefined);
    const inheritedMeta = (isObject && entry.inheritedMeta) || (origRow && origRow._inheritedMeta) || null;
    const isCustomBooking = Boolean((isObject && entry.isCustomBooking) || (origRow && origRow._isCustomBooking));

    if (origRow && Array.isArray(row)) {
      attachRowMeta(row, {
        inheritedMeta,
        isCustomBooking,
        customRowIndex: origRow._customRowIndex
      });
    }

    if (rowIndex === undefined || rowIndex === null) {
      return entry;
    }

    const bookingKey = `ROW_${rowIndex}`;
    const override = overrides[bookingKey];

    if (!override) {
      if (isObject && (inheritedMeta || isCustomBooking)) {
        return {
          ...entry,
          ...(inheritedMeta ? { inheritedMeta } : {}),
          ...(isCustomBooking ? { isCustomBooking: true } : {})
        };
      }
      return entry;
    }

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

    const resolvedIsCustom = isCustomBooking || !!override.isCustomBooking;
    attachRowMeta(mergedRow, {
      inheritedMeta,
      isCustomBooking: resolvedIsCustom,
      customRowIndex: resolvedIsCustom ? rowIndex : undefined
    });

    if (isObject) {
      const resEntry = {
        ...entry,
        row: mergedRow,
        isOverridden: true,
        ...(inheritedMeta ? { inheritedMeta } : {}),
        ...(resolvedIsCustom ? { isCustomBooking: true } : {}),
        overrideMeta: {
          updatedBy: override.updatedBy,
          updatedAt: override.updatedAt,
          createdBy: override.createdBy || override.updatedBy,
          createdAt: override.createdAt || override.updatedAt,
          isCustomBooking: resolvedIsCustom,
          bookingKey,
          fields: override.fields || {}
        }
      };
      if (override.fields?.GUEST_PAX) {
        const p = parseInt(override.fields.GUEST_PAX, 10);
        if (!isNaN(p) && p > 0) resEntry.pax = p;
      }
      if (override.fields?.CONTACTS) {
        resEntry.contacts = override.fields.CONTACTS;
      }
      if (override.fields?.PHONE || override.fields?.CONTACT || override.fields?.WHATSAPP || override.fields?.TEL || override.fields?.MOBILE) {
        resEntry.phone = (override.fields.PHONE || override.fields.CONTACT || override.fields.WHATSAPP || override.fields.TEL || override.fields.MOBILE || '').toString().trim();
      }
      return resEntry;
    } else if (Array.isArray(entry)) {
      // Attach non-enumerable properties or wrapper metadata if needed
      mergedRow.isOverridden = true;
      mergedRow.isCustomBooking = resolvedIsCustom;
      mergedRow.overrideMeta = {
        updatedBy: override.updatedBy,
        updatedAt: override.updatedAt,
        createdBy: override.createdBy || override.updatedBy,
        createdAt: override.createdAt || override.updatedAt,
        isCustomBooking: resolvedIsCustom,
        bookingKey,
        fields: override.fields || {}
      };
      if (override.fields?.CONTACTS) {
        mergedRow.contacts = override.fields.CONTACTS;
      }
      if (override.fields?.PHONE || override.fields?.CONTACT || override.fields?.WHATSAPP || override.fields?.TEL || override.fields?.MOBILE) {
        mergedRow.phone = (override.fields.PHONE || override.fields.CONTACT || override.fields.WHATSAPP || override.fields.TEL || override.fields.MOBILE || '').toString().trim();
      }
      return mergedRow;
    }

    return entry;
  });
}

/**
 * Builds a complete row array and booking object from a custom booking override entry.
 */
function buildCustomBookingEntry(bookingKey, override, headers = []) {
  const rowIndex = typeof override.rowIndex === 'number'
    ? override.rowIndex
    : parseInt(String(bookingKey).replace(/^ROW_/, ''), 10);

  const colCount = Math.max((headers && headers.length) || 27, 27);
  const baseRow = new Array(colCount).fill('');

  const colorIdx = (headers || []).findIndex(h => h && h.toString().trim().toUpperCase() === 'ROW_COLOR');
  const roomIdx = (headers || []).findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');
  const roomPaxIdx = (headers || []).findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM_PAX');

  baseRow[colorIdx !== -1 ? colorIdx : (colCount - 3)] = override.fields?.ROW_COLOR || 'WHITE';
  baseRow[roomIdx !== -1 ? roomIdx : (colCount - 2)] = override.fields?.ROOM || '—';
  baseRow[roomPaxIdx !== -1 ? roomPaxIdx : (colCount - 1)] = override.fields?.ROOM_PAX || override.fields?.GUEST_PAX || '—';

  const fields = override.fields || {};

  if (headers && Array.isArray(headers)) {
    headers.forEach((headerName, colIdx) => {
      if (!headerName) return;
      const val = getOverriddenValue(fields, headerName);
      if (val !== undefined) {
        baseRow[colIdx] = val;
      }
    });
  }

  for (const [colIdxStr, fieldAliases] of Object.entries(FIXED_COLUMN_INDEX_MAPPINGS)) {
    const colIdx = parseInt(colIdxStr, 10);
    if (baseRow.length > colIdx) {
      for (const alias of fieldAliases) {
        if (fields[alias] !== undefined && fields[alias] !== '') {
          baseRow[colIdx] = fields[alias];
          break;
        }
      }
    }
  }

  if (fields.ROOM) {
    baseRow[roomIdx !== -1 ? roomIdx : (colCount - 2)] = fields.ROOM;
  }
  if (fields.ROOM_PAX) {
    baseRow[roomPaxIdx !== -1 ? roomPaxIdx : (colCount - 1)] = fields.ROOM_PAX;
  }

  attachRowMeta(baseRow, {
    isCustomBooking: true,
    customRowIndex: rowIndex
  });

  const entry = {
    row: baseRow,
    rowIndex,
    isOverridden: true,
    isCustomBooking: true,
    overrideMeta: {
      updatedBy: override.updatedBy,
      updatedAt: override.updatedAt,
      createdBy: override.createdBy || override.updatedBy,
      createdAt: override.createdAt || override.updatedAt,
      isCustomBooking: true,
      bookingKey: `ROW_${rowIndex}`,
      fields
    }
  };

  if (fields.GUEST_PAX) {
    const p = parseInt(fields.GUEST_PAX, 10);
    if (!isNaN(p) && p > 0) entry.pax = p;
  }
  if (fields.CONTACTS) {
    entry.contacts = fields.CONTACTS;
  }
  if (fields.PHONE || fields.CONTACT || fields.WHATSAPP || fields.TEL || fields.MOBILE) {
    entry.phone = (fields.PHONE || fields.CONTACT || fields.WHATSAPP || fields.TEL || fields.MOBILE || '').toString().trim();
  }

  return entry;
}

/**
 * Creates a brand-new dashboard custom booking with a unique synthetic rowIndex (>= 100000).
 */
async function createCustomBooking(fields, createdBy, headers = []) {
  const overrides = await loadOverrides(true);
  let maxCustomIdx = 99999;

  for (const [k, val] of Object.entries(overrides || {})) {
    const idxFromKey = k.startsWith('ROW_') ? parseInt(k.replace('ROW_', ''), 10) : NaN;
    const idxFromVal = typeof val?.rowIndex === 'number' ? val.rowIndex : NaN;
    const candidate = !isNaN(idxFromVal) ? idxFromVal : idxFromKey;
    if (!isNaN(candidate) && candidate >= 100000 && candidate > maxCustomIdx) {
      maxCustomIdx = candidate;
    }
  }

  const newRowIndex = maxCustomIdx + 1;
  const bookingKey = `ROW_${newRowIndex}`;
  const nowIso = new Date().toISOString();

  const payload = await saveOverride(
    bookingKey,
    {
      fields: fields || {},
      rowIndex: newRowIndex,
      isCustomBooking: true,
      createdBy: createdBy || 'Admin',
      createdAt: nowIso
    },
    createdBy || 'Admin'
  );

  return buildCustomBookingEntry(bookingKey, payload, headers);
}

/**
 * Returns all active custom bookings formatted as booking entries.
 */
async function getCustomBookingsAsRows(headers = [], explicitOverrides = null) {
  const overrides = explicitOverrides || await module.exports.loadOverrides();
  if (!overrides) return [];

  const list = [];
  for (const [bookingKey, ov] of Object.entries(overrides)) {
    if (ov && ov.isCustomBooking) {
      list.push(buildCustomBookingEntry(bookingKey, ov, headers));
    }
  }

  return list.sort((a, b) => a.rowIndex - b.rowIndex);
}

module.exports = {
  loadOverrides,
  saveOverride,
  deleteOverride,
  getBookingKey,
  attachRowMeta,
  applyOverridesToRows,
  buildCustomBookingEntry,
  createCustomBooking,
  getCustomBookingsAsRows
};

