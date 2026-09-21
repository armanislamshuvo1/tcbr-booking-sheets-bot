const { findHeaderRowIndex, isCancelledText, isPostponedText } = require('./detector');

/**
 * Validates raw spreadsheet rows for critical boat report columns and values.
 *
 * @param {Array[]} rows - Raw spreadsheet rows (with headers).
 * @param {Object} options - Configuration options.
 * @param {string[]} [options.requiredColumns] - Required column headers (case-insensitive).
 * @param {Object} [options.columnMappings] - Custom mappings of columns to expected headers.
 * @param {string[]} [options.allowedStatuses] - List of recognized statuses.
 * @returns {{ valid: boolean, errors: string[], columnIndices: Object }}
 */
function validateBoatData(rows, options = {}) {
  const requiredColumns = options.requiredColumns || ['Booking ID', 'Status', 'Boat Name'];
  const columnMappings = options.columnMappings || {
    'Booking ID': ['BOOKING ID', 'CODE', 'ID'],
    'Status': ['STATUS', 'REMARK', 'REMARKS'],
    'Boat Name': ['BOAT NAME', 'BOAT', 'BOAT_NAME', 'ROOM TYPE', 'ROOM DETAILS']
  };
  const allowedStatuses = (options.allowedStatuses || [
    'confirmed', 'new', 'paid', 'active', 'ok',
    'changed', 'postpone', 'cancel', 'cancelled', 'postponed'
  ]).map(s => s.toLowerCase());

  const errors = [];
  const columnIndices = {};

  if (!rows || rows.length === 0) {
    errors.push('No data found in the spreadsheet.');
    return { valid: false, errors, columnIndices };
  }

  // 1. Locate header row
  const headerIndex = findHeaderRowIndex(rows);
  const headers = rows[headerIndex] || [];

  // 2. Map required columns to indexes
  for (const colName of requiredColumns) {
    const aliases = columnMappings[colName] || [colName];
    let foundIdx = -1;

    for (const alias of aliases) {
      foundIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === alias.toUpperCase());
      if (foundIdx !== -1) break;
    }

    if (foundIdx === -1) {
      errors.push(`Missing required column: "${colName}" (checked: ${aliases.join(', ')})`);
    } else {
      columnIndices[colName] = foundIdx;
    }
  }

  // Halt validation if headers are missing
  if (errors.length > 0) {
    return { valid: false, errors, columnIndices };
  }

  const bookingIdIdx = columnIndices['Booking ID'];
  const statusIdx = columnIndices['Status'];
  const boatNameIdx = columnIndices['Boat Name'];

  // 3. Validate cell data in each booking row
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];

    // Skip empty rows
    if (!row || row.slice(0, -1).every(cell => !cell || cell.toString().trim() === '')) {
      continue;
    }

    const rowNum = i + 1; // 1-indexed for reporting
    const bookingId = (row[bookingIdIdx] || '').toString().trim();
    const status = (row[statusIdx] || '').toString().trim();
    const boatName = (row[boatNameIdx] || '').toString().trim();

    if (!bookingId) {
      errors.push(`Row ${rowNum}: Critical column "Booking ID" is empty.`);
    }

    if (!status) {
      errors.push(`Row ${rowNum}: Critical column "Status" is empty.`);
    } else {
      // Find if the status matches any of the allowed statuses (including checking substrings if it's a REMARK column)
      const normalizedStatus = status.toLowerCase();
      const isValid = allowedStatuses.some(allowed => normalizedStatus.includes(allowed));
      if (!isValid) {
        errors.push(`Row ${rowNum}: Invalid status value "${status}".`);
      }
    }

    if (!boatName) {
      errors.push(`Row ${rowNum}: Critical column "Boat Name" is empty.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    columnIndices
  };
}

/**
 * Filters rows for active bookings to generate the final boat report list.
 *
 * @param {Array[]} rows - Raw spreadsheet rows.
 * @param {Object} columnIndices - Mapping of column keys to their indices.
 * @param {Object} options - Configuration options.
 * @param {string[]} [options.activeStatuses] - List of active statuses.
 * @param {string[]} [options.excludedStatuses] - List of statuses to exclude.
 * @returns {Object[]} Filtered boat report list.
 */
function filterBoatReportList(rows, columnIndices, options = {}) {
  const activeStatuses = (options.activeStatuses || ['confirmed', 'new', 'paid', 'active', 'ok']).map(s => s.toLowerCase());
  const excludedStatuses = (options.excludedStatuses || ['changed', 'postpone', 'cancel', 'cancelled', 'postponed']).map(s => s.toLowerCase());

  const headerIndex = findHeaderRowIndex(rows);
  const filteredList = [];

  const bookingIdIdx = columnIndices['Booking ID'];
  const statusIdx = columnIndices['Status'];
  const boatNameIdx = columnIndices['Boat Name'];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];

    if (!row || row.slice(0, -1).every(cell => !cell || cell.toString().trim() === '')) {
      continue;
    }

    const bookingId = (row[bookingIdIdx] || '').toString().trim();
    const status = (row[statusIdx] || '').toString().trim();
    const boatName = (row[boatNameIdx] || '').toString().trim();

    const normalizedStatus = status.toLowerCase();

    // Exclusion check (exclude cancelled, postponed, or changed)
    const isExcluded = isCancelledText(normalizedStatus) || isPostponedText(normalizedStatus) || excludedStatuses.some(ex => normalizedStatus.includes(ex));
    if (isExcluded) {
      continue;
    }

    // Inclusion check (include active ones)
    const isActive = activeStatuses.some(act => normalizedStatus.includes(act));
    if (isActive) {
      filteredList.push({
        rowIndex: i,
        bookingId,
        status,
        boatName,
        row
      });
    }
  }

  return filteredList;
}

/**
 * High-level pre-send validation and filtering routine.
 * Validates first; if successful, filters and returns the active boat report list.
 * If validation fails, throws a descriptive error.
 *
 * @param {Array[]} rows - Raw sheet data.
 * @param {Object} options - Configuration options.
 * @returns {Object[]} The final active boat report list.
 * @throws {ValidationError} If validation checks fail.
 */
function prepareBoatReportForSending(rows, options = {}) {
  const { valid, errors, columnIndices } = validateBoatData(rows, options);

  if (!valid) {
    const err = new Error(`Pre-Send Validation Failed:\n${errors.join('\n')}`);
    err.name = 'ValidationError';
    err.details = errors;
    throw err;
  }

  return filterBoatReportList(rows, columnIndices, options);
}

module.exports = {
  validateBoatData,
  filterBoatReportList,
  prepareBoatReportForSending
};
