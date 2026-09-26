const express = require('express');
const path    = require('path');
const { loadHistory, loadSnapshot, getDbStatus, acknowledgeEvent, getTotalChecksCount } = require('./snapshot');
const { parseDate, isCancelledText, isPostponedText } = require('./detector');
const { parsePax, parseDivingPax, parseCoursePax } = require('./weeklyReport');
const { 
  initSeedAdmin, 
  loginUser, 
  registerUser, 
  revokeToken, 
  requireAuth, 
  requireAdmin,
  requireRole,
  setAuthCookie,
  clearAuthCookie,
  loginRateLimiter,
  registerRateLimiter
} = require('./auth');
const admin = require('./adminController');
const { applyOverridesToRows } = require('./overrides');

const app = express();


// Middleware to parse JSON bodies
app.use(express.json());

// Set Cache-Control header for API GET requests (no-cache for booking data, private cache for others)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') {
    if (req.path.includes('bookings') || req.path.includes('in-house')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

let runCheckCallback = null;

// ─── Authentication APIs (Public & Protected) ──────────────────────────────────

app.post('/api/auth/register', registerRateLimiter, async (req, res) => {
  try {
    const { username, email, displayName, password } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const result = await registerUser({ username, email, displayName, password }, clientIp);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const result = await loginUser(username, password, clientIp);
    
    // Attach HttpOnly cookie alongside JSON response
    setAuthCookie(res, result.token);

    res.json({ success: true, token: result.token, user: result.user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  if (req.rawToken) revokeToken(req.rawToken);
  clearAuthCookie(res);
  res.json({ success: true, message: 'Logged out successfully.' });
});

app.post('/api/auth/change-password', requireAuth, admin.changePassword);

// ─── Data & Operational APIs (Protected by requireAuth) ───────────────────────

// Fetch change history (Admin & Operator only)
app.get('/api/history', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  const history = await loadHistory();
  if (req.user && req.user.role !== 'admin') {
    const financialKeywords = ['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS'];
    const sanitizedHistory = history.map(ev => {
      const newRows = (ev.newRows || []).map(item => {
        if (!item || !item.headers || !item.row) return item;
        const hiddenIndices = new Set();
        const headers = item.headers.map((h, idx) => {
          if (financialKeywords.includes((h || '').toString().trim().toUpperCase())) {
            hiddenIndices.add(idx);
            return '';
          }
          return h;
        });
        const row = item.row.map((cell, idx) => hiddenIndices.has(idx) ? '' : cell);
        return { ...item, headers, row };
      });

      const modifiedRows = (ev.modifiedRows || []).map(item => {
        if (!item) return item;
        const changes = (item.changes || []).filter(c => !financialKeywords.includes((c.column || '').toString().trim().toUpperCase()));
        let headers = item.headers;
        let row = item.row;
        if (headers && row) {
          const hiddenIndices = new Set();
          headers = headers.map((h, idx) => {
            if (financialKeywords.includes((h || '').toString().trim().toUpperCase())) {
              hiddenIndices.add(idx);
              return '';
            }
            return h;
          });
          row = row.map((cell, idx) => hiddenIndices.has(idx) ? '' : cell);
        }
        return { ...item, changes, headers, row };
      });

      return { ...ev, newRows, modifiedRows };
    });
    return res.json(sanitizedHistory);
  }
  res.json(history);
});

// Health check / status info
app.get('/api/status', async (req, res) => {
  const history = await loadHistory();
  const totalChecks = await getTotalChecksCount();
  const botConfig = await admin.getOrLoadConfig();
  res.json({
    status: botConfig.isPaused ? 'paused' : 'running',
    isPaused: botConfig.isPaused,
    quietHours: { start: botConfig.quietHoursStart, end: botConfig.quietHoursEnd },
    lastCheck: history[0]?.checkedAt || null,
    totalEventsLogged: history.length,
    totalChecks,
    dbStatus: getDbStatus(),
  });
});

function sanitizeFinancials(headers, bookings) {
  const financialKeywords = ['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS'];
  const hiddenIndices = new Set();

  const sanitizedHeaders = (headers || []).map((h, idx) => {
    const upper = (h || '').toString().trim().toUpperCase();
    if (financialKeywords.includes(upper)) {
      hiddenIndices.add(idx);
      return '';
    }
    return h;
  });

  const sanitizedBookings = (bookings || []).map(b => {
    const row = Array.isArray(b.row) ? [...b.row] : [];
    hiddenIndices.forEach(idx => {
      if (idx < row.length) {
        row[idx] = '';
      }
    });
    return {
      ...b,
      row
    };
  });

  return { headers: sanitizedHeaders, bookings: sanitizedBookings };
}

// Current month's active bookings (Accessible to Admin, Operator, and Jetty Staff)
app.get('/api/current-bookings', requireAuth, async (req, res) => {
  try {
    const snapshot = await loadSnapshot();
    if (!snapshot) {
      return res.json({ headers: [], bookings: [] });
    }

    const rawBookings = Object.values(snapshot.monthMap || {}).map(entry => ({
      row: entry.row,
      rowIndex: entry.rowIndex,
    }));
    const bookings = await applyOverridesToRows(rawBookings, snapshot.headers || []);

    // RBAC: ONLY admin can see payment/financial details. For operator and jetty_staff, sanitize them out.
    if (req.user && req.user.role !== 'admin') {
      const sanitized = sanitizeFinancials(snapshot.headers || [], bookings);
      return res.json(sanitized);
    }

    res.json({
      headers: snapshot.headers || [],
      bookings,
    });
  } catch (err) {
    console.error('   ❌ Failed to load current bookings:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// All bookings from Google Sheet snapshot (Admin & Operator only)
app.get('/api/all-bookings', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  try {
    const snapshot = await loadSnapshot();
    if (!snapshot) {
      return res.json({ headers: [], bookings: [] });
    }

    const rawBookings = snapshot.allRows || [];
    const bookings = await applyOverridesToRows(rawBookings, snapshot.headers || []);

    // RBAC: ONLY admin can see payment/financial details. For operator, sanitize them out.
    if (req.user && req.user.role !== 'admin') {
      const sanitized = sanitizeFinancials(snapshot.headers || [], bookings);
      return res.json(sanitized);
    }

    res.json({
      headers: snapshot.headers || [],
      bookings,
    });
  } catch (err) {
    console.error('   ❌ Failed to load all bookings:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function parsePaxString(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.replace(/\([^)]*\)/g, '').trim();
  if (!s) return 0;

  let total = 0;

  const dmRegex = /\+?\s*(\d*)\s*(?:dm|divemaster|dive\s*master)\b/gi;
  let dmMatch;
  while ((dmMatch = dmRegex.exec(s)) !== null) {
    const num = dmMatch[1] ? parseInt(dmMatch[1], 10) : 1;
    total += num;
  }
  s = s.replace(dmRegex, ' ').trim();

  const insRegex = /\+?\s*(\d*)\s*(?:i[nst]+[ruoc]*t[oers]{0,4}|ins|inst|instructor|instructors)\b/gi;
  let insMatch;
  while ((insMatch = insRegex.exec(s)) !== null) {
    const num = insMatch[1] ? parseInt(insMatch[1], 10) : 1;
    total += num;
  }
  s = s.replace(insRegex, ' ').trim();

  // Clean up any extra dive count or free boat dive text so they are not counted as pax
  const diveCountRegex = /[+,&]?\s*(?:free|extra|added|add|with|w\/|inc|incl|including)?\s*\d+\s*(?:(?:boat|fun|leisure|shore|night|check|orientation|extra|additional|free)\s+)*(?:dives?|boats?|trips?)(?:\s*(?:each|after\s*certif\w*|paid(?:\s*at\s*\w+)?|only|per\s*pax|for\s*each\s*pax))?/gi;
  s = s.replace(diveCountRegex, ' ').trim();

  const matches = s.matchAll(/(\d+)/g);
  for (const m of matches) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val)) total += val;
  }

  return total;
}

function getRowActivityPax(row) {
  const snork = (row[4] || '').toString();
  const dive = (row[5] || '').toString();
  const course = (row[6] || '').toString();
  
  const s = parsePax(snork);
  const d = parseDivingPax(dive);
  const c = parseCoursePax(course);
  return (s.a + s.c + s.b) + (d.a + d.c + d.b) + (c.a + c.c + c.b);
}

// Fetch in-house guest stats for a specific date (Admin & Operator only)
app.get('/api/in-house', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  try {
    const snapshot = await loadSnapshot();
    if (!snapshot || !snapshot.allRows) {
      return res.json({ date: req.query.date || null, totalGuests: 0, totalBookings: 0, bookings: [] });
    }

    const targetDateStr = req.query.date;
    let targetDate = new Date();
    if (targetDateStr) {
      const parsed = parseDate(targetDateStr);
      if (parsed) targetDate = parsed;
      else if (!isNaN(new Date(targetDateStr))) targetDate = new Date(targetDateStr);
    }
    targetDate.setHours(0, 0, 0, 0);

    const headers = snapshot.headers || [];
    const roomPaxIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM_PAX');
    const remarkIdx = headers.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
    const specialReqIdx = headers.findIndex(h => h && ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'SPECIAL REQUESTS', 'REQUEST'].includes(h.toString().trim().toUpperCase()));
    const codeIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');

    const roomIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');

    const bookingsByCode = {};

    const rawAllRows = snapshot.allRows || [];
    const allRows = await applyOverridesToRows(rawAllRows, snapshot.headers || []);

    let lastInHouseCode = '';
    let lastInHouseCheckIn = null;
    let lastInHouseCheckOut = null;

    for (let i = 0; i < allRows.length; i++) {
      const item = allRows[i];
      const row = item.row || item;
      
      const remarkVal = (remarkIdx !== -1 ? (row[remarkIdx] || '') : (row[22] || '')).toString().toLowerCase();
      const specialReqVal = (specialReqIdx !== -1 ? (row[specialReqIdx] || '') : (row[13] || '')).toString().toLowerCase();
      if (isCancelledText(combinedVal) || isPostponedText(combinedVal)) {
        continue;
      }

      const rawCode = (codeIdx !== -1 && row[codeIdx]) ? row[codeIdx].toString().trim().toUpperCase() : '';
      const checkInStr = row[7];
      const checkOutStr = row[8];
      let checkIn = parseDate(checkInStr);
      let checkOut = parseDate(checkOutStr);

      if (rawCode) {
        if (rawCode === lastInHouseCode) {
          if (!checkIn && lastInHouseCheckIn) checkIn = lastInHouseCheckIn;
          if (!checkOut && lastInHouseCheckOut) checkOut = lastInHouseCheckOut;
        } else {
          lastInHouseCode = rawCode;
          lastInHouseCheckIn = checkIn;
          lastInHouseCheckOut = checkOut;
        }
      } else {
        lastInHouseCode = '';
        lastInHouseCheckIn = null;
        lastInHouseCheckOut = null;
      }

      if (!checkIn) continue;

      const cIn = new Date(checkIn);
      cIn.setHours(0, 0, 0, 0);

      let cOut = checkOut ? new Date(checkOut) : new Date(cIn);
      cOut.setHours(0, 0, 0, 0);

      let isInHouse = false;
      if (cOut > cIn) {
        isInHouse = (targetDate >= cIn && targetDate < cOut);
      } else {
        isInHouse = (targetDate.getTime() === cIn.getTime());
      }

      if (isInHouse) {
        const rawCode = (codeIdx !== -1 && row[codeIdx]) ? row[codeIdx].toString().trim().toUpperCase() : '';
        const rIndex = item.rowIndex !== undefined ? item.rowIndex : i;
        const codeKey = rawCode ? rawCode : `ROW_${rIndex}`;

        if (!bookingsByCode[codeKey]) {
          bookingsByCode[codeKey] = {
            code: rawCode,
            firstRow: row,
            firstRowIndex: rIndex,
            totalActivityPax: 0,
            roomsMap: {},
            isOverridden: !!item.isOverridden,
            overrideMeta: item.overrideMeta
          };
        }

        bookingsByCode[codeKey].totalActivityPax = Math.max(bookingsByCode[codeKey].totalActivityPax, getRowActivityPax(row));

        const roomStr = roomIdx !== -1 ? (row[roomIdx] || '') : '';
        if (roomStr && roomStr !== '—') {
          const cleanStr = roomStr.toString().replace(/➔/g, ',').replace(/\([^)]*changed[^)]*\)/gi, '');
          const parts = cleanStr.split(',');
          parts.forEach(part => {
            const p = part.trim();
            if (!p) return;
            const match = p.match(/([A-Z0-9]+)\s*(?:\((\d+)\s*Pax\))?/i);
            if (match) {
              const roomName = match[1].toUpperCase();
              const pax = match[2] ? parseInt(match[2], 10) : 1;
              bookingsByCode[codeKey].roomsMap[roomName] = Math.max(bookingsByCode[codeKey].roomsMap[roomName] || 0, pax);
            }
          });
        }
      }
    }

    const inHouseBookings = [];
    let totalGuests = 0;

    for (const key in bookingsByCode) {
      const group = bookingsByCode[key];

      let pax = 1;
      if (group.totalActivityPax > 0) {
        pax = group.totalActivityPax;
      } else {
        let roomPaxSum = 0;
        for (const rName in group.roomsMap) {
          roomPaxSum += group.roomsMap[rName];
        }
        if (roomPaxSum > 0) {
          pax = roomPaxSum;
        }
      }

      totalGuests += pax;
      inHouseBookings.push({
        row: group.firstRow,
        rowIndex: group.firstRowIndex,
        pax,
        isOverridden: group.isOverridden,
        overrideMeta: group.overrideMeta
      });
    }

    res.json({
      date: targetDate.toISOString().split('T')[0],
      totalGuests,
      totalBookings: inHouseBookings.length,
      bookings: inHouseBookings,
    });
  } catch (err) {
    console.error('   ❌ Failed to fetch in-house stats:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Trigger manual check (Admin & Operator only)
app.post('/api/check', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  try {
    if (runCheckCallback) {
      await runCheckCallback(false, true);
      res.json({ success: true, message: 'Sheet check completed successfully.' });
    } else {
      res.status(500).json({ error: 'Check trigger callback not registered on the server.' });
    }
  } catch (err) {
    console.error('   ❌ Manual check trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Acknowledge event (Admin & Operator only)
app.post('/api/history/acknowledge', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  try {
    const { id, user, category } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing event ID' });
    }

    const ackUser = user || req.user.username || 'Dashboard User';
    const success = await acknowledgeEvent(id, ackUser, category || 'reception');
    if (success) {
      res.json({ success: true, message: 'Event acknowledged.' });
    } else {
      res.status(404).json({ error: 'Event not found or already acknowledged.' });
    }
  } catch (err) {
    console.error('   ❌ Event acknowledgement API error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Internal notes endpoints (Admin & Operator only)
app.post('/api/notes', requireAuth, requireRole('admin', 'operator'), admin.createInternalNote);
app.get('/api/notes', requireAuth, requireRole('admin', 'operator'), admin.fetchInternalNotes);

// ─── Admin Portal APIs (Protected by requireAuth & requireAdmin) ───────────────

app.get('/api/admin/users', requireAuth, requireAdmin, admin.getUsers);
app.post('/api/admin/users', requireAuth, requireAdmin, admin.createUser);
app.post('/api/admin/users/:userId/approve', requireAuth, requireAdmin, admin.approveUser);
app.put('/api/admin/users/:userId/role', requireAuth, requireAdmin, admin.updateUserRole);
app.delete('/api/admin/users/:userId', requireAuth, requireAdmin, admin.deleteUser);

app.get('/manifest.json', async (req, res) => {
  try {
    const { loadBotConfig } = require('./snapshot');
    const config = await loadBotConfig();
    const resortName = config?.resortName || 'TCBR Booking';
    res.json({
      short_name: 'TCBR Booking',
      name: resortName.includes('TCBR Booking') ? resortName : `${resortName} — TCBR Booking`,
      icons: [
        { src: '/icon-192.png', type: 'image/png', sizes: '192x192' },
        { src: '/icon-512.png', type: 'image/png', sizes: '512x512' }
      ],
      start_url: '/',
      background_color: '#0d1117',
      theme_color: '#161b22',
      display: 'standalone',
      orientation: 'portrait'
    });
  } catch {
    res.sendFile(path.join(__dirname, '..', 'public', 'manifest.json'));
  }
});

app.get('/api/public/branding', admin.getPublicBranding);
app.get('/api/admin/bot/settings', requireAuth, requireAdmin, admin.getBotSettings);
app.post('/api/admin/bot/settings', requireAuth, requireAdmin, admin.updateBotSettings);

app.post('/api/admin/telegram/test', requireAuth, requireAdmin, admin.testTelegramPing);
app.get('/api/admin/telemetry', requireAuth, requireAdmin, admin.getTelemetryStats);
app.post('/api/admin/snapshot/reset', requireAuth, requireAdmin, admin.resetSnapshotBaseline);
app.get('/api/admin/export/:type', requireAuth, requireAdmin, admin.exportData);
app.get('/api/admin/audit-logs', requireAuth, requireAdmin, admin.getAuditLogsHandler);

// Dashboard Booking Overrides APIs (Accessible to Admin & Operator)
app.put('/api/admin/bookings/override', requireAuth, requireRole('admin', 'operator'), admin.updateBookingOverride);
app.delete('/api/admin/bookings/override', requireAuth, requireAdmin, admin.revertBookingOverride);

// Admin Boat Transfer Report APIs
app.post('/api/admin/reports/boat-transfer/preview', requireAuth, requireAdmin, admin.previewBoatTransferReport);
app.post('/api/admin/reports/boat-transfer/send', requireAuth, requireAdmin, admin.sendBoatTransferReport);

// Admin Telegram & Bot Commands Action Center API
app.post('/api/admin/commands/run', requireAuth, requireAdmin, admin.runAdminCommand);

async function startDashboard(runCheckFn) {
  runCheckCallback = runCheckFn;
  if (admin.setRunCheckCallback) {
    admin.setRunCheckCallback(runCheckFn);
  }
  await initSeedAdmin(); // Initialize default admin account if needed

  const port = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`🌐 Dashboard running at http://localhost:${port}`);
  });
}

module.exports = { startDashboard, app };
