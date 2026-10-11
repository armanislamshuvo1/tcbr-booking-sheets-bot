const fs   = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { rowKey, findHeaderRowIndex } = require('./detector');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const HISTORY_FILE  = path.join(DATA_DIR, 'change_history.json');
const STATS_FILE    = path.join(DATA_DIR, 'stats.json');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const AUDIT_FILE    = path.join(DATA_DIR, 'audit_logs.json');
const NOTES_FILE    = path.join(DATA_DIR, 'notes.json');
const CONFIG_FILE   = path.join(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let mongoClient = null;
let db = null;
let dbStatus = { connected: false, type: 'local', error: 'Database not initialized' };

// In-memory cache variables
let cachedSnapshot = null;
let lastSnapshotLoadTime = 0;
let cachedHistory = null;
let lastHistoryLoadTime = 0;
const CACHE_TTL = 10000; // Cache for 10 seconds (10 * 1000 ms)

/**
 * Get the current database connection status.
 */
function getDbStatus() {
  return dbStatus;
}

/**
 * Connect to MongoDB if the MONGODB_URI is provided.
 */
async function getDb() {
  if (!process.env.MONGODB_URI) {
    dbStatus = {
      connected: false,
      type: 'local',
      error: 'MONGODB_URI environment variable is not set.'
    };
    return null;
  }
  if (db) {
    dbStatus = { connected: true, type: 'mongodb', error: null };
    return db;
  }

  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db();
    console.log('   ✅ Connected to MongoDB successfully snapshot 57');
    dbStatus = { connected: true, type: 'mongodb', error: null };
    
    // Create TTL Index for history collection - 14 days (1209600 seconds)
    try {
      await db.collection('history').createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 14 * 24 * 60 * 60 }
      );
      console.log('   ✅ MongoDB history TTL index verified (14 days)');
    } catch (indexErr) {
      console.error('   ⚠️ Failed to create history TTL index:', indexErr.message);
    }

    return db;
  } catch (err) {
    console.error('   ❌ Failed to connect to MongoDB:', err.message);
    dbStatus = { connected: false, type: 'local', error: err.message };
    db = null;
    return null;
  }
}

/**
 * Load the previous snapshot from MongoDB or fallback to disk.
 * Returns null if no snapshot exists yet.
 */
async function loadSnapshot() {
  const now = Date.now();
  // Serve from cache if still valid
  if (cachedSnapshot && (now - lastSnapshotLoadTime < CACHE_TTL)) {
    return cachedSnapshot;
  }

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('snapshots');
      const doc = await collection.findOne({ type: 'current_baseline' });
      
      cachedSnapshot = doc ? doc.data : null;
      lastSnapshotLoadTime = now;
      return cachedSnapshot;
    } catch (err) {
      console.error('   ❌ MongoDB loadSnapshot error:', err.message);
      return null;
    }
  }

  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    cachedSnapshot = data;
    lastSnapshotLoadTime = now;
    return data;
  } catch {
    return null;
  }
}

/**
 * Save the current snapshot to MongoDB or fallback to disk.
 * @param {Array[]} allRows        - Full sheet data
 * @param {Array}   currentMonthRows - Rows matching this month
 */
async function saveSnapshot(
  allRows,
  currentMonthRows,
  sentReminders = undefined,
  lastWeeklyReportTime = undefined,
  lastReportMessages = undefined,
  lastHousekeepingMessages = undefined,
  lastHousekeepingReportTime = undefined
) {
  const prev = cachedSnapshot || await loadSnapshot() || {};
  const resolvedSentReminders = sentReminders !== undefined ? sentReminders : (prev.sentReminders || {});
  const resolvedLastWeeklyReportTime = lastWeeklyReportTime !== undefined ? lastWeeklyReportTime : (prev.lastWeeklyReportTime || null);
  const resolvedLastReportMessages = lastReportMessages !== undefined ? lastReportMessages : (prev.lastReportMessages || null);
  const resolvedLastHousekeepingMessages = lastHousekeepingMessages !== undefined ? lastHousekeepingMessages : (prev.lastHousekeepingMessages || null);
  const resolvedLastHousekeepingReportTime = lastHousekeepingReportTime !== undefined ? lastHousekeepingReportTime : (prev.lastHousekeepingReportTime || null);

  const headerIndex = findHeaderRowIndex(allRows);
  const headers = allRows[headerIndex] || [];

  // Format all data rows (excluding headers and empty rows)
  const allRowsData = [];
  for (let i = headerIndex + 1; i < allRows.length; i++) {
    const row = allRows[i];
    // Skip empty/blank rows
    if (!row || row.every(cell => !cell || cell.toString().trim() === '')) {
      continue;
    }
    allRowsData.push({
      row,
      rowIndex: i
    });
  }

  const snapshot = {
    savedAt: new Date().toISOString(),
    totalRows: allRows.length,
    headers, // Keep the headers saved in snapshot for current bookings endpoint
    monthMap: {},
    allRows: allRowsData, // Save all rows data for the "All Bookings" tab
    sentReminders: resolvedSentReminders,
    lastWeeklyReportTime: resolvedLastWeeklyReportTime,
    lastReportMessages: resolvedLastReportMessages, // { headerId, dateMessages: { "YYYY-MM-DD": messageId }, dateHashes: { "YYYY-MM-DD": hash } }
    lastHousekeepingMessages: resolvedLastHousekeepingMessages, // { dateMessages: { "YYYY-MM-DD": messageId }, dateHashes: { "YYYY-MM-DD": hash } }
    lastHousekeepingReportTime: resolvedLastHousekeepingReportTime,
  };

  for (let idx = 0; idx < (currentMonthRows || []).length; idx++) {
    const entry = currentMonthRows[idx];
    if (!entry) continue;
    const r = Array.isArray(entry.row) ? entry.row : (Array.isArray(entry) ? entry : null);
    if (!r) continue;
    const rIdx = entry.rowIndex !== undefined ? entry.rowIndex : idx;
    const key = rowKey(r, rIdx);
    snapshot.monthMap[key] = {
      row: r,
      rowIndex: rIdx,
    };
  }

  // Update in-memory cache immediately
  cachedSnapshot = snapshot;
  lastSnapshotLoadTime = Date.now();

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('snapshots');
      await collection.updateOne(
        { type: 'current_baseline' },
        { $set: { type: 'current_baseline', data: snapshot, updatedAt: new Date() } },
        { upsert: true }
      );
      return;
    } catch (err) {
      console.error('   ❌ MongoDB saveSnapshot error:', err.message);
    }
  }

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf-8');
}

/**
 * Update report message tracking fields on the existing snapshot without re-building all rows.
 * @param {object} fields - { lastReportMessages, lastWeeklyReportTime, lastHousekeepingMessages, lastHousekeepingReportTime }
 */
async function updateSnapshotReportState(fields = {}) {
  const current = cachedSnapshot || await loadSnapshot();
  if (!current) return null;

  const updated = {
    ...current,
    ...(fields.lastReportMessages !== undefined ? { lastReportMessages: fields.lastReportMessages } : {}),
    ...(fields.lastWeeklyReportTime !== undefined ? { lastWeeklyReportTime: fields.lastWeeklyReportTime } : {}),
    ...(fields.lastHousekeepingMessages !== undefined ? { lastHousekeepingMessages: fields.lastHousekeepingMessages } : {}),
    ...(fields.lastHousekeepingReportTime !== undefined ? { lastHousekeepingReportTime: fields.lastHousekeepingReportTime } : {}),
  };

  cachedSnapshot = updated;
  lastSnapshotLoadTime = Date.now();

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('snapshots');
      await collection.updateOne(
        { type: 'current_baseline' },
        { $set: { type: 'current_baseline', data: updated, updatedAt: new Date() } },
        { upsert: true }
      );
      return updated;
    } catch (err) {
      console.error('   ❌ MongoDB updateSnapshotReportState error:', err.message);
    }
  }

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

/**
 * Append a change event to the history log (used by the dashboard).
 */
async function appendHistory(event) {
  // Invalidate history cache to fetch fresh data on next reload
  cachedHistory = null;
  lastHistoryLoadTime = 0;

  // Increment the total checks count
  await incrementTotalChecks();

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      await collection.insertOne({ ...event, createdAt: new Date() });
      return;
    } catch (err) {
      console.error('   ❌ MongoDB appendHistory error:', err.message);
    }
  }

  let history = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch {}
  }

  history.unshift(event); // newest first

  // Local fallback: keep only last 14 days
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  history = history.filter(h => {
    const dateToCheck = h.checkedAt ? new Date(h.checkedAt) : new Date(h.createdAt);
    return dateToCheck >= cutoff;
  });

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Append a bot/system error to the history log so admins can view it on the dashboard.
 * @param {Error|string} error
 * @param {object} context - { source, details, id, checkedAt, incrementCheck }
 */
async function appendErrorLog(error, context = {}) {
  try {
    const crypto = require('crypto');
    const errorMsg = (error instanceof Error) ? error.message : String(error || 'Unknown error');
    const event = {
      id: context.id || crypto.randomUUID(),
      checkedAt: context.checkedAt || new Date().toISOString(),
      error: errorMsg,
      errorSource: context.source || 'System',
      errorDetails: context.details || (error instanceof Error && error.stack ? error.stack : null),
    };

    cachedHistory = null;
    lastHistoryLoadTime = 0;

    if (context.incrementCheck) {
      await incrementTotalChecks();
    }

    const db = await getDb();
    if (db) {
      try {
        const collection = db.collection('history');
        await collection.insertOne({ ...event, createdAt: new Date() });
        return event;
      } catch (err) {
        console.error('   ❌ MongoDB appendErrorLog error:', err.message);
      }
    }

    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch {}
    }

    history.unshift(event);

    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    history = history.filter(h => {
      const dateToCheck = h.checkedAt ? new Date(h.checkedAt) : new Date(h.createdAt);
      return dateToCheck >= cutoff;
    });

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    return event;
  } catch (logErr) {
    console.error('   ❌ Failed to write error log to history:', logErr.message);
    return null;
  }
}

/**
 * Append a verification to an existing report event in history.
 * If the event exists, pushes to its verifications array.
 * If not, creates a new event entry.
 */
async function appendVerification(eventId, username) {
  cachedHistory = null;
  lastHistoryLoadTime = 0;

  const verification = {
    by: username,
    at: new Date().toISOString(),
  };

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      const existing = await collection.findOne({ id: eventId });
      if (existing) {
        await collection.updateOne(
          { id: eventId },
          { $push: { verifications: verification } }
        );
      } else {
        await collection.insertOne({
          id: eventId,
          type: 'weekly_report',
          checkedAt: new Date().toISOString(),
          verifications: [verification],
          createdAt: new Date(),
        });
      }
      return;
    } catch (err) {
      console.error('   ❌ MongoDB appendVerification error:', err.message);
    }
  }

  // Local file fallback
  let history = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch {}
  }

  const existing = history.find(item => item.id === eventId);
  if (existing) {
    if (!existing.verifications) existing.verifications = [];
    existing.verifications.push(verification);
  } else {
    history.unshift({
      id: eventId,
      type: 'weekly_report',
      checkedAt: new Date().toISOString(),
      verifications: [verification],
    });
  }

  if (history.length > 500) history = history.slice(0, 500);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Get all verifications for a report event.
 */
async function getVerifications(eventId) {
  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      const doc = await collection.findOne({ id: eventId });
      return doc?.verifications || [];
    } catch (err) {
      return [];
    }
  }

  let history = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch {}
  }
  const item = history.find(h => h.id === eventId);
  return item?.verifications || [];
}

/**
 * Load change history for the dashboard.
 */
async function loadHistory() {
  const now = Date.now();
  // Serve from cache if still valid
  if (cachedHistory && (now - lastHistoryLoadTime < CACHE_TTL)) {
    return cachedHistory;
  }

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      // Set a larger limit since documents naturally expire after 14 days via TTL index
      const docs = await collection.find({}).sort({ checkedAt: -1 }).limit(3000).toArray();
      
      const mapped = docs.map(doc => {
        const { _id, ...rest } = doc;
        return rest;
      });
      cachedHistory = mapped;
      lastHistoryLoadTime = now;
      return mapped;
    } catch (err) {
      console.error('   ❌ MongoDB loadHistory error:', err.message);
      return [];
    }
  }

  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    let data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    // Local fallback: keep only last 14 days
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    data = data.filter(h => {
      const dateToCheck = h.checkedAt ? new Date(h.checkedAt) : new Date(h.createdAt);
      return dateToCheck >= cutoff;
    });
    cachedHistory = data;
    lastHistoryLoadTime = now;
    return data;
  } catch {
    return [];
  }
}

/**
 * Acknowledge a change event by its ID.
 */
async function acknowledgeEvent(eventId, username, category = 'reception') {
  // Clear cache to reflect updates
  cachedHistory = null;
  lastHistoryLoadTime = 0;

  const prefix = category === 'dive_center' ? 'acknowledgedDiveCenter' : 'acknowledgedReception';

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      const result = await collection.updateOne(
        { id: eventId },
        { 
          $set: { 
            [`${prefix}`]: true, 
            [`${prefix}By`]: username, 
            [`${prefix}At`]: new Date().toISOString() 
          } 
        }
      );
      return result.modifiedCount > 0;
    } catch (err) {
      console.error('   ❌ MongoDB acknowledgeEvent error:', err.message);
      return false;
    }
  }

  if (!fs.existsSync(HISTORY_FILE)) return false;
  try {
    let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    const idx = history.findIndex(item => item.id === eventId);
    if (idx !== -1) {
      history[idx][`${prefix}`] = true;
      history[idx][`${prefix}By`] = username;
      history[idx][`${prefix}At`] = new Date().toISOString();
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
      return true;
    }
    return false;
  } catch (err) {
    console.error('   ❌ Local file acknowledgeEvent error:', err.message);
    return false;
  }
}

/**
 * Clear all change history and snapshot baseline (monthly reset).
 */
async function clearMonthData() {
  // Clear in-memory caches
  cachedSnapshot = null;
  lastSnapshotLoadTime = 0;
  cachedHistory = null;
  lastHistoryLoadTime = 0;

  const db = await getDb();
  if (db) {
    try {
      await db.collection('history').deleteMany({});
      await db.collection('snapshots').deleteMany({ type: 'current_baseline' });
      console.log('   🗑️  MongoDB history and snapshot cleared.');
      return;
    } catch (err) {
      console.error('   ❌ MongoDB clearMonthData error:', err.message);
    }
  }

  // Local fallback
  if (fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, '[]', 'utf-8');
  }
  if (fs.existsSync(SNAPSHOT_FILE)) {
    fs.unlinkSync(SNAPSHOT_FILE);
  }
  console.log('   🗑️  Local history and snapshot cleared.');
}

async function incrementTotalChecks() {
  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('stats');
      await collection.updateOne(
        { _id: 'global' },
        { $inc: { totalChecks: 1 } },
        { upsert: true }
      );
      return;
    } catch (err) {
      console.error('   ❌ MongoDB incrementTotalChecks error:', err.message);
    }
  }

  let total = 0;
  if (fs.existsSync(STATS_FILE)) {
    try {
      const content = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
      total = content.totalChecks || 0;
    } catch {}
  }
  total++;
  fs.writeFileSync(STATS_FILE, JSON.stringify({ totalChecks: total }, null, 2), 'utf-8');
}

async function getTotalChecksCount() {
  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('stats');
      const doc = await collection.findOne({ _id: 'global' });
      return doc ? (doc.totalChecks || 0) : 0;
    } catch (err) {
      console.error('   ❌ MongoDB getTotalChecksCount error:', err.message);
      return 0;
    }
  }

  if (!fs.existsSync(STATS_FILE)) return 0;
  try {
    const content = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    return content.totalChecks || 0;
  } catch {
    return 0;
  }
}

// ─── User Persistence ────────────────────────────────────────────────────────
async function loadUsers() {
  const db = await getDb();
  if (db) {
    try {
      return await db.collection('users').find({}).toArray();
    } catch (err) {
      console.error('   ❌ MongoDB loadUsers error:', err.message);
    }
  }

  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

async function saveUsers(users) {
  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('users');
      await collection.deleteMany({});
      if (users.length > 0) {
        await collection.insertMany(users);
      }
      return;
    } catch (err) {
      console.error('   ❌ MongoDB saveUsers error:', err.message);
    }
  }

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

// ─── Audit Log Persistence ────────────────────────────────────────────────────
async function appendAuditLog(entry) {
  const auditDoc = {
    id: entry.id || require('crypto').randomUUID(),
    timestamp: new Date().toISOString(),
    username: entry.username || 'System',
    role: entry.role || 'system',
    action: entry.action,
    details: entry.details || '',
    ip: entry.ip || 'internal'
  };

  const db = await getDb();
  if (db) {
    try {
      await db.collection('audit_logs').insertOne(auditDoc);
      return auditDoc;
    } catch (err) {
      console.error('   ❌ MongoDB appendAuditLog error:', err.message);
    }
  }

  let logs = [];
  if (fs.existsSync(AUDIT_FILE)) {
    try {
      logs = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf-8'));
    } catch {}
  }
  logs.unshift(auditDoc);
  if (logs.length > 500) logs = logs.slice(0, 500); // keep last 500
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  return auditDoc;
}

async function loadAuditLogs() {
  const db = await getDb();
  if (db) {
    try {
      return await db.collection('audit_logs').find({}).sort({ timestamp: -1 }).limit(200).toArray();
    } catch (err) {
      console.error('   ❌ MongoDB loadAuditLogs error:', err.message);
    }
  }

  if (!fs.existsSync(AUDIT_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// ─── Internal Notes Persistence ───────────────────────────────────────────────
async function addNote({ targetId, note, createdBy }) {
  const noteDoc = {
    id: require('crypto').randomUUID(),
    targetId, // Event ID or Booking Row key
    note,
    createdBy,
    createdAt: new Date().toISOString()
  };

  const db = await getDb();
  if (db) {
    try {
      await db.collection('notes').insertOne(noteDoc);
      return noteDoc;
    } catch (err) {
      console.error('   ❌ MongoDB addNote error:', err.message);
    }
  }

  let notes = [];
  if (fs.existsSync(NOTES_FILE)) {
    try { notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8')); } catch {}
  }
  notes.unshift(noteDoc);
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), 'utf-8');
  return noteDoc;
}

async function getNotes() {
  const db = await getDb();
  if (db) {
    try {
      return await db.collection('notes').find({}).sort({ createdAt: -1 }).toArray();
    } catch (err) {
      console.error('   ❌ MongoDB getNotes error:', err.message);
    }
  }

  if (!fs.existsSync(NOTES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// ─── Bot Dynamic Configuration Persistence ──────────────────────────────────
const DEFAULT_CONFIG = {
  isPaused: false,
  quietHoursStart: 23,
  quietHoursEnd: 7,
  snoozeHours: parseInt(process.env.ERROR_ALERT_SNOOZE_HOURS || '6', 10),
  resortName: 'Tenggol Coral Beach Resort',
  resortTagline: 'TCBR Booking Blatform',
  logoUrl: '/tcb-logo.png',
  primaryColor: '#58a6ff',
  brandAccent: '#2ea043',
  jettyName: "A'king Jetty",
  jettyMapUrl: 'https://maps.app.goo.gl/VQwW3qZxqb4qGd2e9',
  assemblyTime: '09:30 AM',
  departureTime: '10:30 AM',
  contactPhone: '+60 12-345 6789'
};

async function loadBotConfig() {
  const db = await getDb();
  if (db) {
    try {
      const doc = await db.collection('config').findOne({ _id: 'bot_settings' });
      if (doc && doc.config) return { ...DEFAULT_CONFIG, ...doc.config };
    } catch (err) {
      console.error('   ❌ MongoDB loadBotConfig error:', err.message);
    }
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const fileData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...fileData };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveBotConfig(config) {
  const db = await getDb();
  if (db) {
    try {
      await db.collection('config').updateOne(
        { _id: 'bot_settings' },
        { $set: { config, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
      return;
    } catch (err) {
      console.error('   ❌ MongoDB saveBotConfig error:', err.message);
    }
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

module.exports = {
  getDb,
  loadSnapshot,
  saveSnapshot,
  updateSnapshotReportState,
  appendHistory,
  appendErrorLog,
  appendVerification,
  getVerifications,
  loadHistory,
  getDbStatus,
  acknowledgeEvent,
  clearMonthData,
  incrementTotalChecks,
  getTotalChecksCount,
  loadUsers,
  saveUsers,
  appendAuditLog,
  loadAuditLogs,
  addNote,
  getNotes,
  loadBotConfig,
  saveBotConfig
};

