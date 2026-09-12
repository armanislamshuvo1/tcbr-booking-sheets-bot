let allHistory = [];
let currentBookings = [];
let allBookings = [];
let bookingsHeaders = [];
let activeFilter = 'all';
let currentUser = null;

// ── Auth Fetch Wrapper ──
async function authFetch(url, options = {}) {
  const token = localStorage.getItem('sheets_auth_token');
  options.headers = options.headers || {};
  options.credentials = options.credentials || 'same-origin';
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  
  const res = await fetch(url, options);
  if (res.status === 401) {
    localStorage.removeItem('sheets_auth_token');
    currentUser = null;
    showAuthOverlay();
    throw new Error('Unauthorized');
  }
  return res;
}

// ── Trigger manual sheet check from dashboard ──
async function triggerManualCheck() {
  const btn = document.getElementById('trigger-btn');
  if (!btn) return;
  
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="refresh-icon spinning">⏱</span> Checking...';
  
  try {
    const res = await authFetch('/api/check', { method: 'POST' });
    const data = await res.json();
    
    if (res.ok && data.success) {
      await loadData(true);
      showToast('✅ Sheet check completed successfully!');
    } else {
      showToast('❌ Error: ' + (data.error || 'Failed to complete check.'));
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      console.error(err);
      showToast('❌ Network error while triggering check.');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ── Acknowledge card from dashboard ──
async function acknowledgeCard(eventId, category, buttonEl, event) {
  if (event) event.stopPropagation();
  if (!eventId) return;
  
  const savedName = localStorage.getItem('ack_username') || currentUser?.username || '';
  const username = prompt("Please enter your name for acknowledgment:", savedName);
  if (username === null) return;
  
  const finalUsername = username.trim() || currentUser?.username || 'Dashboard User';
  if (username.trim()) {
    localStorage.setItem('ack_username', finalUsername);
  }
  
  buttonEl.disabled = true;
  const originalText = buttonEl.textContent;
  buttonEl.textContent = 'Acknowledging...';
  
  try {
    const res = await authFetch('/api/history/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: eventId, user: finalUsername, category })
    });
    
    if (res.ok) {
      await loadData(true);
    } else {
      showToast('❌ Failed to acknowledge event.');
      buttonEl.disabled = false;
      buttonEl.textContent = originalText;
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      console.error(err);
      showToast('❌ Error connecting to server.');
      buttonEl.disabled = false;
      buttonEl.textContent = originalText;
    }
  }
}

// Helper toast notification
function showToast(msg) {
  let toast = document.getElementById('dashboard-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dashboard-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.background = 'var(--bg-secondary)';
    toast.style.border = '1px solid var(--border)';
    toast.style.color = 'var(--text-primary)';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = 'var(--radius-sm)';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    toast.style.zIndex = '9999';
    toast.style.fontSize = '0.88rem';
    toast.style.transition = 'all 0.3s ease';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 4000);
}

let activeTab = 'changelog'; // 'changelog', 'bookings', or 'allbookings'
let displayLimit = 50; // Client-side pagination limit for rendering speed

const DASHBOARD_CACHE_KEY = 'sheets_bot_dashboard_cache_v3';
const CACHE_TTL_MS = 10 * 1000; // 10 seconds cache TTL

function applyDashboardData(data) {
  allHistory = data.history || [];
  const status = data.status || {};

  const currentBookingsData = data.currentBookings || {};
  currentBookings = currentBookingsData.bookings || [];
  bookingsHeaders = currentBookingsData.headers || [];

  const allBookingsData = data.allBookings || {};
  allBookings = allBookingsData.bookings || [];

  updateStats(status);
  renderContent();

  const lastCheck = status.lastCheck
    ? new Date(status.lastCheck).toLocaleString()
    : 'Never';
  const lastCheckEl = document.getElementById('last-check-time');
  if (lastCheckEl) lastCheckEl.textContent = lastCheck;

  // Update Database Status Badge
  const dbBadge = document.getElementById('db-status-badge');
  if (dbBadge && status.dbStatus) {
    if (status.dbStatus.connected) {
      dbBadge.style.backgroundColor = 'var(--green-bg)';
      dbBadge.style.color = 'var(--green)';
      dbBadge.style.borderColor = 'rgba(63,185,80,0.3)';
      dbBadge.style.borderStyle = 'solid';
      dbBadge.style.borderWidth = '1px';
      dbBadge.textContent = '🔌 DB: Connected';
      dbBadge.title = 'Successfully connected to MongoDB. Data is persistent across restarts.';
    } else {
      dbBadge.style.backgroundColor = 'var(--red-bg)';
      dbBadge.style.color = 'var(--red)';
      dbBadge.style.borderColor = 'rgba(248,81,73,0.3)';
      dbBadge.style.borderStyle = 'solid';
      dbBadge.style.borderWidth = '1px';
      dbBadge.textContent = '⚠️ DB: Local Fallback';
      dbBadge.title = 'Using ephemeral local fallback (WARNING: Data will be lost when Render restarts!).\nError: ' + (status.dbStatus.error || 'Unknown error');
    }
  }
}

// ── Load data from API with localStorage caching ────────────────────────────
async function loadData(forceRefresh = false) {
  const btn = document.getElementById('refresh-btn');
  const isJetty = currentUser && currentUser.role === 'jetty_staff';
  const roleCacheKey = `${DASHBOARD_CACHE_KEY}_${currentUser?.role || 'anon'}`;

  // Check localStorage cache first if not a forced refresh
  if (!forceRefresh) {
    try {
      const cachedRaw = localStorage.getItem(roleCacheKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        const age = Date.now() - (cached.timestamp || 0);
        if (age < CACHE_TTL_MS) {
          console.log(`⚡ Rendered dashboard instantly from local cache (${Math.round(age / 1000)}s old)`);
          applyDashboardData(cached);
          return;
        }
      }
    } catch (e) {
      console.warn('Failed to parse dashboard cache:', e);
    }
  }

  if (btn) btn.classList.add('spinning');

  try {
    const ts = forceRefresh ? `?_t=${Date.now()}` : '';
    let history = [];
    let status = {};
    let currentBookingsData = { headers: [], bookings: [] };
    let allBookingsData = { headers: [], bookings: [] };

    if (isJetty) {
      // Jetty staff only loads current bookings & status (avoids forbidden 403 endpoints)
      const [statusRes, currentBookingsRes] = await Promise.all([
        authFetch(`/api/status${ts}`),
        authFetch(`/api/current-bookings${ts}`),
      ]);
      status = await statusRes.json();
      currentBookingsData = await currentBookingsRes.json();
    } else {
      // Admin & Operator load full history and all bookings
      const [historyRes, statusRes, currentBookingsRes, allBookingsRes] = await Promise.all([
        authFetch(`/api/history${ts}`),
        authFetch(`/api/status${ts}`),
        authFetch(`/api/current-bookings${ts}`),
        authFetch(`/api/all-bookings${ts}`),
      ]);
      history = await historyRes.json();
      status = await statusRes.json();
      currentBookingsData = await currentBookingsRes.json();
      allBookingsData = await allBookingsRes.json();
    }

    const freshCache = {
      timestamp: Date.now(),
      history,
      status,
      currentBookings: currentBookingsData,
      allBookings: allBookingsData,
    };

    try {
      localStorage.setItem(roleCacheKey, JSON.stringify(freshCache));
    } catch (e) {
      console.warn('Failed to save dashboard cache to localStorage:', e);
    }

    applyDashboardData(freshCache);

  } catch (err) {
    console.error('Failed to load data:', err);
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

// ── Update stat cards ───────────────────────────────────────────────────────
function updateStats(status) {
  const isJetty = currentUser && currentUser.role === 'jetty_staff';
  const statTotalEl = document.getElementById('stat-total');
  const statNewEl = document.getElementById('stat-new');
  const statModEl = document.getElementById('stat-modified');
  const statErrEl = document.getElementById('stat-errors');

  if (isJetty) {
    if (statTotalEl) statTotalEl.textContent = currentBookings.length;
    return;
  }

  let newCount = 0, modCount = 0, errCount = 0;
  for (const event of allHistory) {
    if (event.error) { errCount++; continue; }
    newCount += (event.newRows || []).length;
    modCount += (event.modifiedRows || []).length;
  }
  const totalChecks = (status && typeof status.totalChecks !== 'undefined') ? status.totalChecks : allHistory.length;

  if (statTotalEl) statTotalEl.textContent = totalChecks;
  if (statNewEl) statNewEl.textContent = newCount;
  if (statModEl) statModEl.textContent = modCount;
  if (statErrEl) statErrEl.textContent = errCount;
}

// ── Tab switcher ────────────────────────────────────────────────────────────
function setTab(tabName) {
  // Enforce Jetty Staff role constraint: can ONLY view 'bookings'
  if (currentUser && currentUser.role === 'jetty_staff' && tabName !== 'bookings') {
    tabName = 'bookings';
  }
  activeTab = tabName;
  
  // Update active tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const targetTabBtn = document.getElementById('tab-' + tabName);
  if (targetTabBtn) targetTabBtn.classList.add('active');

  // Show/hide category filters (only for changelog)
  const filterBar = document.getElementById('category-filters');
  const monthFilterContainer = document.getElementById('month-filter-container');
  const viewTitleEl = document.getElementById('view-title');

  if (tabName === 'changelog') {
    if (filterBar) filterBar.style.display = 'flex';
    if (monthFilterContainer) monthFilterContainer.style.display = 'none';
    if (viewTitleEl) viewTitleEl.innerHTML = '📋 Change Log';
  } else if (tabName === 'inhouse') {
    if (filterBar) filterBar.style.display = 'none';
    if (monthFilterContainer) monthFilterContainer.style.display = 'none';
    if (viewTitleEl) viewTitleEl.innerHTML = '🏠 In-House Guests List';
  } else if (tabName === 'bookings') {
    if (filterBar) filterBar.style.display = 'none';
    if (monthFilterContainer) monthFilterContainer.style.display = 'none';
    if (viewTitleEl) viewTitleEl.innerHTML = '📅 Current Month Bookings';
  } else {
    if (filterBar) filterBar.style.display = 'none';
    if (monthFilterContainer) monthFilterContainer.style.display = 'flex';
    if (viewTitleEl) viewTitleEl.innerHTML = '🌎 All Bookings';
  }

  // Reset month filter and display limit when switching tabs
  const monthFilterInput = document.getElementById('month-filter-input');
  if (monthFilterInput) monthFilterInput.value = '';
  displayLimit = 50;

  renderContent();
}

// ── Filter ──────────────────────────────────────────────────────────────────
function setFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.remove('active','active-green','active-yellow');
  });
  const btn = document.getElementById('filter-' + filter);
  if (btn) {
    if (filter === 'new')      btn.classList.add('active-green');
    else if (filter === 'modified') btn.classList.add('active-yellow');
    else btn.classList.add('active');
  }
  renderContent();
}

function getMonthIndexFromText(text) {
  if (!text || typeof text !== 'string') return -1;
  const lower = text.toLowerCase();
  if (lower.includes('jan')) return 0;
  if (lower.includes('feb')) return 1;
  if (lower.includes('mar')) return 2;
  if (lower.includes('apr')) return 3;
  if (lower.includes('may')) return 4;
  if (lower.includes('jun')) return 5;
  if (lower.includes('jul')) return 6;
  if (lower.includes('aug')) return 7;
  if (lower.includes('sep')) return 8;
  if (lower.includes('oct')) return 9;
  if (lower.includes('nov')) return 10;
  if (lower.includes('dec')) return 11;
  return -1;
}

// Helper to parse dates client-side
function parseClientDate(value) {
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
    const year = 2000 + parseInt(year2, 10);
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

  // 5. Handle textual formats with ordinal suffixes (e.g. "23rd Aug", "15th Aug", "22nd Aug", "25th AUg")
  const dayMatch = trimmed.match(/^(\d+)/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    const month = getMonthIndexFromText(trimmed);
    if (month !== -1) {
      const year = new Date().getFullYear();
      const parsed = new Date(year, month, day);
      if (!isNaN(parsed)) return parsed;
    }
  }

  // 6. Native parse fallback for strings like "August 23, 2026"
  const nativeDate = new Date(trimmed);
  if (!isNaN(nativeDate) && !/^\d+$/.test(trimmed)) {
    return nativeDate;
  }

  return null;
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

// ── Theme Auto-Detection & Switching ─────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

// Initialize theme on script execution
initTheme();

function parsePaxString(str) {
  if (!str || typeof str !== 'string') return 0;
  // Ignore numbers inside parentheses (e.g. "(7 Dives)", "(5 Dives)")
  let s = str.replace(/\([^)]*\)/g, '').trim();
  if (!s) return 0;

  let total = 0;

  // 1. Match DM / Dive Master / Divemaster
  const dmRegex = /\+?\s*(\d*)\s*(?:dm|divemaster|dive\s*master)\b/gi;
  let dmMatch;
  while ((dmMatch = dmRegex.exec(s)) !== null) {
    const num = dmMatch[1] ? parseInt(dmMatch[1], 10) : 1;
    total += num;
  }
  s = s.replace(dmRegex, ' ').trim();

  // 2. Match Ins / Instructor / Instructors
  const insRegex = /\+?\s*(\d*)\s*(?:i[nst]+[ruoc]*t[oers]{0,4}|ins|inst|instructor|instructors)\b/gi;
  let insMatch;
  while ((insMatch = insRegex.exec(s)) !== null) {
    const num = insMatch[1] ? parseInt(insMatch[1], 10) : 1;
    total += num;
  }
  s = s.replace(insRegex, ' ').trim();

  // 3. Match remaining numbers
  const matches = s.matchAll(/(\d+)/g);
  for (const m of matches) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val)) total += val;
  }

  return total;
}

function parseSnorkPaxClient(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.replace(/\([^)]*\)/g, '').trim();
  if (!s) return 0;
  let total = 0;

  // 1. Identify Instructor / Ins
  const insRegex = /\+?\s*(\d*)\s*(?:i[nst]+[ruoc]*t[oers]{0,4}|ins|inst|instructor|instructors)\b/gi;
  let insMatch;
  while ((insMatch = insRegex.exec(s)) !== null) {
    const count = insMatch[1] ? parseInt(insMatch[1], 10) : 1;
    total += count;
  }
  s = s.replace(insRegex, ' ').trim();

  // 2. Identify Dive Master / DM
  const dmRegex = /\+?\s*(\d*)\s*(?:dm|divemaster|dive\s*master)\b/gi;
  let dmMatch;
  while ((dmMatch = dmRegex.exec(s)) !== null) {
    const count = dmMatch[1] ? parseInt(dmMatch[1], 10) : 1;
    total += count;
  }
  s = s.replace(dmRegex, ' ').trim();

  const numA = s.match(/(\d+)\s*A(?=\s|$|[^A-Za-z])/i);
  const numC = s.match(/(\d+)\s*C(?=\s|$|[^A-Za-z])/i);
  const numB = s.match(/(\d+)\s*Baby\b/i);
  if (numA) total += parseInt(numA[1], 10);
  if (numC) total += parseInt(numC[1], 10);
  if (numB) total += parseInt(numB[1], 10);
  return total;
}

function parseDivingPaxClient(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.replace(/\([^)]*\)/g, '').trim();
  if (!s) return 0;
  let total = 0;

  // 1. Identify Dive Master / DM
  const dmRegex = /\+?\s*(\d*)\s*(?:dm|divemaster|dive\s*master)\b/gi;
  let dmMatch;
  while ((dmMatch = dmRegex.exec(s)) !== null) {
    const count = dmMatch[1] ? parseInt(dmMatch[1], 10) : 1;
    total += count;
  }
  s = s.replace(dmRegex, ' ').trim();

  // 2. Identify Instructor / Ins
  const insRegex = /\+?\s*(\d*)\s*(?:i[nst]+[ruoc]*t[oers]{0,4}|ins|inst|instructor|instructors)\b/gi;
  let insMatch;
  while ((insMatch = insRegex.exec(s)) !== null) {
    const count = insMatch[1] ? parseInt(insMatch[1], 10) : 1;
    total += count;
  }
  s = s.replace(insRegex, ' ').trim();

  // 3. Match all "NUMBER A" patterns (e.g. "7A", "1A", "2 A") and remove them
  const matchesA = Array.from(s.matchAll(/(\d+)\s*A(?=\s|$|[^A-Za-z])/gi));
  for (const m of matchesA) {
    total += parseInt(m[1], 10);
  }
  s = s.replace(/(\d+)\s*A(?=\s|$|[^A-Za-z])/gi, ' ').trim();

  if (/\bA\b/i.test(s)) {
    total += 1;
    s = s.replace(/\bA\b/i, ' ').trim();
  }

  // 4. Match C/Child/Jr Diver/Junior patterns and remove them
  const matchesC = Array.from(s.matchAll(/(\d+)\s*(?:C\b|child|kid|jr|junior)/gi));
  for (const m of matchesC) {
    total += parseInt(m[1], 10);
  }
  s = s.replace(/(\d+)\s*(?:C\b|child|kid|jr|junior)[a-z-]*/gi, ' ').trim();

  // 5. Match Baby patterns and remove them
  const matchesB = Array.from(s.matchAll(/(\d+)\s*Baby\b/gi));
  for (const m of matchesB) {
    total += parseInt(m[1], 10);
  }
  s = s.replace(/(\d+)\s*Baby\b/gi, ' ').trim();

  // 6. Check for remaining numbers in the text (e.g., bare numbers "2", "5 dives", or other diver titles)
  const remainingNumbers = Array.from(s.matchAll(/(\d+)/g));
  for (const m of remainingNumbers) {
    total += parseInt(m[1], 10);
  }

  return total;
}

function parseCoursePaxClient(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.replace(/\([^)]*\)/g, '').trim();
  s = s.replace(/\+?\s*(?:free\s*)?\d+\s*(?:boat\s*)?dives?(?:\s*each)?/gi, '').trim();
  if (!s) return 0;
  let total = 0;
  const matches = s.match(/\d+\s*[A-Za-z][A-Za-z-]*/g);
  if (matches) {
    for (const m of matches) {
      const numMatch = m.match(/^(\d+)/);
      if (numMatch) total += parseInt(numMatch[1], 10);
    }
    return total;
  }
  const bareNum = s.match(/^(\d+)$/);
  if (bareNum) return parseInt(bareNum[1], 10);
  return 1;
}

function getRowActivityPaxClient(rowData) {
  const snork = (rowData[4] || '').toString();
  const dive = (rowData[5] || '').toString();
  const course = (rowData[6] || '').toString();
  return parseSnorkPaxClient(snork) + parseDivingPaxClient(dive) + parseCoursePaxClient(course);
}

// ── In-House Guests Calculation ──────────────────────────────────
function updateInHouseStats(targetDate) {
  const tDate = targetDate ? new Date(targetDate) : new Date();
  tDate.setHours(0, 0, 0, 0);

  const bookingsList = (allBookings && allBookings.length > 0) ? allBookings : currentBookings;
  const roomPaxIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM_PAX');
  const roomIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');
  const checkInIdx = bookingsHeaders.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
  const checkOutIdx = bookingsHeaders.findIndex(h => h && ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'].includes(h.toString().trim().toUpperCase()));
  const remarkIdx = bookingsHeaders.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
  const specialReqIdx = bookingsHeaders.findIndex(h => h && ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'SPECIAL REQUESTS', 'REQUEST'].includes(h.toString().trim().toUpperCase()));
  const codeIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');

  const bookingsByCode = {};

  bookingsList.forEach((item, index) => {
    const rowData = item.row || [];
    const remarkVal = (remarkIdx !== -1 ? (rowData[remarkIdx] || '') : (rowData[22] || '')).toString().toLowerCase();
    const specialReqVal = (specialReqIdx !== -1 ? (rowData[specialReqIdx] || '') : (rowData[13] || '')).toString().toLowerCase();
    const combinedVal = `${remarkVal} ${specialReqVal}`;

    // Exclude cancelled or postponed bookings
    if (combinedVal.includes('cancel') || combinedVal.includes('cancle') || combinedVal.includes('cancelled') || combinedVal.includes('postpone') || combinedVal.includes('postponed')) {
      return;
    }

    const checkIn = parseClientDate(rowData[checkInIdx !== -1 ? checkInIdx : 7]);
    const checkOut = parseClientDate(rowData[checkOutIdx !== -1 ? checkOutIdx : 8]);

    if (!checkIn) return;
    const cIn = new Date(checkIn);
    cIn.setHours(0, 0, 0, 0);

    let cOut = checkOut ? new Date(checkOut) : new Date(cIn);
    cOut.setHours(0, 0, 0, 0);

    let isInHouse = false;
    if (cOut > cIn) {
      isInHouse = (tDate >= cIn && tDate < cOut);
    } else {
      isInHouse = (tDate.getTime() === cIn.getTime());
    }

    if (isInHouse) {
      const rawCode = (codeIdx !== -1 && rowData[codeIdx]) ? rowData[codeIdx].toString().trim().toUpperCase() : '';
      const rIndex = item.rowIndex !== undefined ? item.rowIndex : index;
      const codeKey = rawCode ? rawCode : `ROW_${rIndex}`;

      if (!bookingsByCode[codeKey]) {
        bookingsByCode[codeKey] = {
          code: rawCode,
          totalActivityPax: 0,
          roomsMap: {}
        };
      }

      bookingsByCode[codeKey].totalActivityPax = Math.max(bookingsByCode[codeKey].totalActivityPax, getRowActivityPaxClient(rowData));

      const roomStr = roomIdx !== -1 ? (rowData[roomIdx] || '') : '';
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
  });

  let totalPax = 0;
  let totalBookingsInHouse = 0;

  for (const key in bookingsByCode) {
    const group = bookingsByCode[key];
    totalBookingsInHouse++;

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

    totalPax += pax;
  }

  const statInhouseEl = document.getElementById('stat-inhouse');
  const statInhouseSubEl = document.getElementById('stat-inhouse-sub');
  const inHouseBadgeEl = document.getElementById('in-house-count-badge');

  const dateFormatted = tDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const isToday = isSameDay(tDate, new Date());
  const dateLabel = isToday ? `Today (${dateFormatted})` : dateFormatted;

  if (statInhouseEl) statInhouseEl.textContent = `${totalPax} Pax`;
  if (statInhouseSubEl) statInhouseSubEl.textContent = `${totalBookingsInHouse} booking${totalBookingsInHouse !== 1 ? 's' : ''} (${dateLabel})`;
  
  if (inHouseBadgeEl) {
    if (currentUser && currentUser.role === 'jetty_staff') {
      inHouseBadgeEl.style.display = 'none';
    } else {
      inHouseBadgeEl.textContent = `🏠 ${totalPax} In-House Guests (${dateLabel})`;
      inHouseBadgeEl.style.display = (activeTab === 'bookings' || activeTab === 'allbookings') ? 'inline-flex' : 'none';
    }
  }
}

let searchTimeout = null;
function handleSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    renderContent();
  }, 200); // 200ms debounce to prevent freezing while typing
}

function handleDateSelect() {
  renderContent();
}

function handleMonthSelect() {
  renderContent();
}

function clearDateFilters() {
  const searchEl = document.getElementById('search-input');
  const checkinEl = document.getElementById('checkin-date-input');
  const checkoutEl = document.getElementById('checkout-date-input');
  const monthEl = document.getElementById('month-filter-input');
  if (searchEl) searchEl.value = '';
  if (checkinEl) checkinEl.value = '';
  if (checkoutEl) checkoutEl.value = '';
  if (monthEl) monthEl.value = '';
  displayLimit = 50; // Reset pagination limit
  renderContent();
}

function loadMoreBookings() {
  displayLimit += 100;
  renderContent();
}

// ── Render content ──────────────────────────────────────────────────────────
function renderContent() {
  const container = document.getElementById('changes-list');
  const badgeCountEl = document.getElementById('items-count-badge');

  if (!container) return;

  const searchQuery = document.getElementById('search-input')?.value.toLowerCase().trim() || '';
  const checkinDateVal = document.getElementById('checkin-date-input')?.value || '';
  const checkoutDateVal = document.getElementById('checkout-date-input')?.value || '';
  const monthFilterVal = document.getElementById('month-filter-input')?.value || '';

  let parsedCheckInDate = null;
  if (checkinDateVal) {
    parsedCheckInDate = new Date(checkinDateVal);
  }

  let parsedCheckOutDate = null;
  if (checkoutDateVal) {
    parsedCheckOutDate = new Date(checkoutDateVal);
  }

  // Update In-House Guests statistics for the target date
  updateInHouseStats(parsedCheckInDate);

  if (activeTab === 'inhouse') {
    renderInHouseList(container, searchQuery, parsedCheckInDate, badgeCountEl);
    return;
  }

  if (activeTab === 'changelog') {
    // --- Render Change Log ---
    const items = [];
    for (const event of allHistory) {
      if (event.error) {
        items.push({ type: 'error', event });
        continue;
      }
      for (const row of (event.newRows || [])) {
        items.push({ 
          type: 'new', 
          row, 
          checkedAt: event.checkedAt,
          eventId: event.id,
          acknowledgedReception: event.acknowledgedReception || false,
          acknowledgedReceptionBy: event.acknowledgedReceptionBy || null,
          acknowledgedReceptionAt: event.acknowledgedReceptionAt || null,
          acknowledgedDiveCenter: event.acknowledgedDiveCenter || false,
          acknowledgedDiveCenterBy: event.acknowledgedDiveCenterBy || null,
          acknowledgedDiveCenterAt: event.acknowledgedDiveCenterAt || null
        });
      }
      for (const row of (event.modifiedRows || [])) {
        items.push({ 
          type: 'modified', 
          row, 
          checkedAt: event.checkedAt,
          eventId: event.id,
          acknowledgedReception: event.acknowledgedReception || false,
          acknowledgedReceptionBy: event.acknowledgedReceptionBy || null,
          acknowledgedReceptionAt: event.acknowledgedReceptionAt || null,
          acknowledgedDiveCenter: event.acknowledgedDiveCenter || false,
          acknowledgedDiveCenterBy: event.acknowledgedDiveCenterBy || null,
          acknowledgedDiveCenterAt: event.acknowledgedDiveCenterAt || null
        });
      }
    }

    // Filter by category
    let filtered = activeFilter === 'all'
      ? items
      : items.filter(i => i.type === activeFilter);

    // Filter by search query / dates
    if (searchQuery || parsedCheckInDate || parsedCheckOutDate) {
      filtered = filtered.filter(item => {
        if (item.type === 'error') {
          return searchQuery ? item.event.error.toLowerCase().includes(searchQuery) : true;
        }

        const rowData = item.row.row || [];
        const code = (rowData[1] || '').toString().toLowerCase();
        const pic = (rowData[2] || '').toString().toLowerCase();
        const name = (rowData[3] || '').toString().toLowerCase();
        const checkInStr = (rowData[7] || '').toString();
        const checkOutStr = (rowData[8] || '').toString();

        if (searchQuery) {
          const matchesCode = code.includes(searchQuery);
          const matchesPic = pic.includes(searchQuery);
          const matchesName = name.includes(searchQuery);
          const matchesCheckIn = checkInStr.toLowerCase().includes(searchQuery);
          const matchesCheckOut = checkOutStr.toLowerCase().includes(searchQuery);
          if (!matchesCode && !matchesPic && !matchesName && !matchesCheckIn && !matchesCheckOut) return false;
        }

        if (parsedCheckInDate) {
          const checkInDate = parseClientDate(checkInStr);
          const checkInMatches = checkInDate && isSameDay(checkInDate, parsedCheckInDate);
          if (!checkInMatches) return false;
        }

        if (parsedCheckOutDate) {
          const checkOutDate = parseClientDate(checkOutStr);
          const checkOutMatches = checkOutDate && isSameDay(checkOutDate, parsedCheckOutDate);
          if (!checkOutMatches) return false;
        }

        return true;
      });
    }

    if (badgeCountEl) badgeCountEl.textContent = `${filtered.length} event${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      if (!searchQuery && !parsedCheckInDate && !parsedCheckOutDate && items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">📋</div>
            <h3>No changes detected yet</h3>
            <p>The bot will notify you here and on Telegram<br>when it finds new or modified rows this month.</p>
          </div>`;
      } else {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">🔍</div>
            <h3>No matching changes found</h3>
            <p>Try adjusting your search query or filters.</p>
          </div>`;
      }
      return;
    }

    container.innerHTML = filtered.map((item, idx) => buildCard(item, idx)).join('');

  } else {
    // --- Render Bookings (Current or All) ---
    let filtered = activeTab === 'bookings' ? [...currentBookings] : [...allBookings];

    // Filter by search query / dates / month
    if (searchQuery || parsedCheckInDate || parsedCheckOutDate || monthFilterVal !== '') {
      filtered = filtered.filter(item => {
        const rowData = item.row || [];
        const code = (rowData[1] || '').toString().toLowerCase();
        const pic = (rowData[2] || '').toString().toLowerCase();
        const name = (rowData[3] || '').toString().toLowerCase();
        const checkInStr = (rowData[7] || '').toString();
        const checkOutStr = (rowData[8] || '').toString();

        if (searchQuery) {
          const matchesCode = code.includes(searchQuery);
          const matchesPic = pic.includes(searchQuery);
          const matchesName = name.includes(searchQuery);
          const matchesCheckIn = checkInStr.toLowerCase().includes(searchQuery);
          const matchesCheckOut = checkOutStr.toLowerCase().includes(searchQuery);
          if (!matchesCode && !matchesPic && !matchesName && !matchesCheckIn && !matchesCheckOut) return false;
        }

        if (parsedCheckInDate) {
          const checkInDate = parseClientDate(checkInStr);
          const checkInMatches = checkInDate && isSameDay(checkInDate, parsedCheckInDate);
          if (!checkInMatches) return false;
        }

        if (parsedCheckOutDate) {
          const checkOutDate = parseClientDate(checkOutStr);
          const checkOutMatches = checkOutDate && isSameDay(checkOutDate, parsedCheckOutDate);
          if (!checkOutMatches) return false;
        }

        if (monthFilterVal !== '') {
          const targetMonth = parseInt(monthFilterVal, 10);
          const checkInDate = parseClientDate(checkInStr);
          const checkOutDate = parseClientDate(checkOutStr);

          const checkInMatches = checkInDate && checkInDate.getMonth() === targetMonth;
          const checkOutMatches = checkOutDate && checkOutDate.getMonth() === targetMonth;

          let spansMonth = false;
          if (checkInDate && checkOutDate) {
            const year = checkInDate.getFullYear();
            const startOfMonth = new Date(year, targetMonth, 1, 0, 0, 0, 0);
            const endOfMonth = new Date(year, targetMonth + 1, 0, 23, 59, 59, 999);
            spansMonth = (checkInDate <= endOfMonth && checkOutDate >= startOfMonth);
          }

          if (!checkInMatches && !checkOutMatches && !spansMonth) return false;
        }

        return true;
      });
    }

    if (badgeCountEl) badgeCountEl.textContent = `${filtered.length} booking${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      const hasNoBookings = (activeTab === 'bookings' ? currentBookings.length : allBookings.length) === 0;
      if (!searchQuery && !parsedCheckInDate && !parsedCheckOutDate && monthFilterVal === '' && hasNoBookings) {
        const emptyText = activeTab === 'bookings' 
          ? 'No active bookings this month' 
          : 'No bookings found in the Google Sheet';
        const emptyDesc = activeTab === 'bookings'
          ? 'Bookings matching the current month will automatically load here.'
          : 'Check your Google Sheet data and ensure the service account has read access.';
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">📅</div>
            <h3>${emptyText}</h3>
            <p>${emptyDesc}</p>
          </div>`;
      } else {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">🔍</div>
            <h3>No matching bookings found</h3>
            <p>Try adjusting your search query or date filter.</p>
          </div>`;
      }
      return;
    }

    const sliced = filtered.slice(0, displayLimit);
    let html = sliced.map((booking, idx) => buildBookingCard(booking, idx)).join('');

    if (filtered.length > displayLimit) {
      html += `
        <div style="text-align: center; margin-top: 24px; margin-bottom: 24px;">
          <button class="refresh-btn" onclick="loadMoreBookings()" style="padding: 10px 24px; font-size: 0.88rem; border-radius: var(--radius-sm); margin: 0 auto; display: inline-flex; align-items: center; justify-content: center; gap: 8px;">
            ➕ Load More Bookings (${filtered.length - displayLimit} remaining)
          </button>
        </div>`;
    }
    container.innerHTML = html;
  }
}

// Helper to check if a color is effectively white (including off-white / light grey like rgb(243,243,243))
function isColorWhite(color) {
  if (!color) return true;
  const str = color.toString().trim().toUpperCase();
  if (str === 'WHITE' || str === '' || str === '—') return true;
  const m = str.match(/RGB\((\d+),\s*(\d+),\s*(\d+)\)/i);
  if (m) {
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    if (r >= 235 && g >= 235 && b >= 235) return true;
  }
  return false;
}

// ── Build a single change card ──────────────────────────────────────────────
function buildCard(item, idx) {
  const id = `card-${idx}`;

  if (item.type === 'error') {
    return `
      <div class="change-card modified" id="${id}">
        <div class="card-header" onclick="toggleCard('${id}')">
          <div class="card-left">
            <span class="type-badge modified">ERROR</span>
            <span class="card-title">Bot Error</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="card-time">${formatTime(item.event.checkedAt)}</span>
            <span class="chevron">▼</span>
          </div>
        </div>
        <div class="card-body">
          <p style="color:var(--red);font-weight:500">${escapeHtml(item.event.error)}</p>
        </div>
      </div>`;
  }

  const row = item.row;
  const rowData = row.row || [];
  const headers = row.headers || [];
  
  // Find customer name, booking code, and check-in date dynamically for a more descriptive card title
  const nameIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NAME');
  const codeIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
  const checkInIndex = headers.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
  
  const name = nameIndex !== -1 ? (rowData[nameIndex] || '').toString().trim() : (rowData[3] || '').toString().trim();
  const code = codeIndex !== -1 ? (rowData[codeIndex] || '').toString().trim() : (rowData[1] || '').toString().trim();
  const checkIn = checkInIndex !== -1 ? (rowData[checkInIndex] || '').toString().trim() : (rowData[7] || '').toString().trim();
  const roomIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');
  const room = roomIndex !== -1 ? rowData[roomIndex] : '';
  
  const colorIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROW_COLOR');
  const rowColor = colorIndex !== -1 ? (rowData[colorIndex] || 'WHITE') : 'WHITE';

  const remarkIndex = headers.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
  const specialReqIndex = headers.findIndex(h => h && ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'SPECIAL REQUESTS', 'REQUEST'].includes(h.toString().trim().toUpperCase()));
  const remarkVal = remarkIndex !== -1 ? (rowData[remarkIndex] || '') : (rowData[22] || '');
  const specialReqVal = specialReqIndex !== -1 ? (rowData[specialReqIndex] || '') : (rowData[13] || '');
  let remarkBadge = '';
  let titleRemarkInfo = '';

  const isRowWhite = isColorWhite(rowColor);
  const combinedRemark = `${remarkVal} ${specialReqVal}`.trim();
  const lowerRemark = combinedRemark.toLowerCase();
  const isCancelled = lowerRemark.includes('cancel') || lowerRemark.includes('cancle') || lowerRemark.includes('cancled') || lowerRemark.includes('cancelled');

  // Special remark check (cancel, postpone, double code, duplicate, etc.)
  const isSpecialRemark = isCancelled ||
                         lowerRemark.includes('postpone') || lowerRemark.includes('postponed') ||
                         lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged') ||
                         lowerRemark.includes('double') || lowerRemark.includes('dup');

  if (isRowWhite || isCancelled) {
    if (isSpecialRemark && combinedRemark) {
      let icon = '';
      let badgeText = '';
      let badgeBg = 'var(--red-bg)';
      let badgeColor = 'var(--red)';
      let badgeBorder = 'rgba(248,81,73,0.3)';

      if (isCancelled) {
        icon = '❌ ';
        badgeText = '❌ Cancelled';
      } else if (lowerRemark.includes('postpone') || lowerRemark.includes('postponed')) {
        icon = '⏳ ';
        badgeText = '⏳ Postponed';
      } else if (lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged')) {
        icon = '🔄 ';
        badgeText = '🔄 Changed';
      } else if (lowerRemark.includes('double') || lowerRemark.includes('dup')) {
        icon = '⚠️ ';
        badgeText = '⚠️ Double Code';
      }

      if (badgeText) {
        remarkBadge = `<span class="type-badge" style="background:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder};text-transform:none;margin-left:4px;display:inline-flex;align-items:center;gap:4px">${badgeText}</span>`;
      }

      let displayRemarkText = remarkVal.toString().trim();
      const lowerRemarkOnly = remarkVal.toString().toLowerCase();
      const lowerSpecialOnly = specialReqVal.toString().toLowerCase();
      const isSpecialInRemark = lowerRemarkOnly.includes('cancel') || lowerRemarkOnly.includes('cancle') || lowerRemarkOnly.includes('cancled') || lowerRemarkOnly.includes('cancelled') || lowerRemarkOnly.includes('postpone') || lowerRemarkOnly.includes('postponed') || lowerRemarkOnly.includes('change') || lowerRemarkOnly.includes('changed') || lowerRemarkOnly.includes('chage') || lowerRemarkOnly.includes('chaged') || lowerRemarkOnly.includes('double') || lowerRemarkOnly.includes('dup');
      const isSpecialInReq = lowerSpecialOnly.includes('cancel') || lowerSpecialOnly.includes('cancle') || lowerSpecialOnly.includes('cancled') || lowerSpecialOnly.includes('cancelled') || lowerSpecialOnly.includes('postpone') || lowerSpecialOnly.includes('postponed') || lowerSpecialOnly.includes('change') || lowerSpecialOnly.includes('changed') || lowerSpecialOnly.includes('chage') || lowerSpecialOnly.includes('chaged') || lowerSpecialOnly.includes('double') || lowerSpecialOnly.includes('dup');

      if (isSpecialInRemark) {
        displayRemarkText = remarkVal.toString().trim();
      } else if (isSpecialInReq) {
        displayRemarkText = specialReqVal.toString().trim();
      } else {
        displayRemarkText = remarkVal.toString().trim() || specialReqVal.toString().trim();
      }

      titleRemarkInfo = ` • ${icon}${displayRemarkText}`;
    }
  }

  const cardTitle = name 
    ? `${name}${code ? ` (${code})` : ''}${checkIn ? ` • In: ${checkIn}` : ''}${room && room !== '—' ? ` • 🚪 ${room}` : ''}${titleRemarkInfo}` 
    : (rowData[0] || '—');
  const typeLabel = item.type === 'new' ? 'NEW ROW' : 'MODIFIED';
  const cardClass = item.type === 'new' ? 'new-row' : 'modified';
  const badgeClass = item.type === 'new' ? 'new' : 'modified';

  let bodyHtml = '';

  if (item.type === 'new') {
    // Show all non-empty cells
    const rows = headers
      .map((h, i) => {
        const val = (rowData[i] || '').toString().trim();
        if (!val) return '';
        if (['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS', 'ROW_COLOR'].includes(h.toUpperCase().trim())) return '';
        return `<tr><td style="color:var(--text-secondary);width:35%">${escapeHtml(h)}</td><td>${escapeHtml(val)}</td></tr>`;
      })
      .filter(Boolean)
      .join('');

    bodyHtml = `
      <table class="row-table" style="margin-top:12px">
        <thead><tr><th>Column</th><th>Value</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="2" style="color:var(--text-muted)">No data</td></tr>'}</tbody>
      </table>`;

  } else {
    // Show only changed cells with before/after
    const changes = (row.changes || []);
    const changesRows = changes
      .map(c => {
        if (['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS', 'ROW_COLOR'].includes(c.column.toUpperCase().trim())) return '';
        return `
          <tr>
            <td style="color:var(--text-secondary);width:30%">${escapeHtml(c.column)}</td>
            <td>
              <span class="diff-before">${escapeHtml(c.before) || '(empty)'}</span>
              <span class="diff-arrow">→</span>
              <span class="diff-after">${escapeHtml(c.after) || '(empty)'}</span>
            </td>
          </tr>`;
      })
      .filter(Boolean)
      .join('');

    // Show full row data
    const fullRows = headers
      .map((h, i) => {
        const val = (rowData[i] || '').toString().trim();
        if (!val) return '';
        if (['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS', 'ROW_COLOR'].includes(h.toUpperCase().trim())) return '';
        return `<tr><td style="color:var(--text-secondary);width:35%">${escapeHtml(h)}</td><td>${escapeHtml(val)}</td></tr>`;
      })
      .filter(Boolean)
      .join('');

    bodyHtml = `
      <div style="margin-top: 12px; font-weight: 600; font-size: 0.85rem; color: var(--yellow);">⚡ Changes:</div>
      <table class="row-table" style="margin-top:6px; margin-bottom: 16px;">
        <thead><tr><th>Column</th><th>Change</th></tr></thead>
        <tbody>${changesRows}</tbody>
      </table>
      
      <div style="font-weight: 600; font-size: 0.85rem; color: var(--text-secondary);">📋 Full Row Data:</div>
      <table class="row-table" style="margin-top:6px;">
        <thead><tr><th>Column</th><th>Value</th></tr></thead>
        <tbody>${fullRows || '<tr><td colspan="2" style="color:var(--text-muted)">No data</td></tr>'}</tbody>
      </table>`;
  }

  let ackHtml = '';
  if (item.type !== 'error') {
    const ackRec = item.acknowledgedReception;
    const ackRecBy = item.acknowledgedReceptionBy;
    const ackRecAt = item.acknowledgedReceptionAt;

    const ackDiv = item.acknowledgedDiveCenter;
    const ackDivBy = item.acknowledgedDiveCenterBy;
    const ackDivAt = item.acknowledgedDiveCenterAt;

    let recPart = '';
    if (ackRec) {
      recPart = `
        <span class="ack-badge">
          🛎 Reception: Acknowledged by ${escapeHtml(ackRecBy)} ${ackRecAt ? `at ${new Date(ackRecAt).toLocaleTimeString()}` : ''}
        </span>`;
    } else if (item.eventId) {
      recPart = `
        <button class="ack-btn" onclick="acknowledgeCard('${item.eventId}', 'reception', this, event)">
          🛎 Acknowledge Reception
        </button>`;
    }

    let divPart = '';
    if (ackDiv) {
      divPart = `
        <span class="ack-badge" style="background:var(--accent-glow);color:var(--accent);border-color:rgba(88,166,255,0.3)">
          🤿 Dive Center: Acknowledged by ${escapeHtml(ackDivBy)} ${ackDivAt ? `at ${new Date(ackDivAt).toLocaleTimeString()}` : ''}
        </span>`;
    } else if (item.eventId) {
      divPart = `
        <button class="ack-btn" style="background:var(--accent-glow);color:var(--accent);border-color:rgba(88,166,255,0.3)" onclick="acknowledgeCard('${item.eventId}', 'dive_center', this, event)">
          🤿 Acknowledge Dive Center
        </button>`;
    }

    ackHtml = `
      <div class="ack-section" style="border-top: 1px dashed var(--border); margin-top: 16px; padding-top: 4px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        ${recPart}
        ${divPart}
      </div>`;
  }

  return `
    <div class="change-card ${cardClass}" id="${id}" style="${rowColor !== 'WHITE' ? `border-left: 3px solid ${rowColor} !important;` : ''}">
      <div class="card-header" onclick="toggleCard('${id}')">
        <div class="card-left">
          <span class="type-badge ${badgeClass}">${typeLabel}</span>
          <span class="card-title">${escapeHtml(String(cardTitle))}</span>
          ${remarkBadge}
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="card-time">${formatTime(item.checkedAt)}</span>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="card-body">
        ${bodyHtml}
        ${ackHtml}
      </div>
    </div>`;
}

// Helper to detect Room Change vs Group Booking
function parseRoomDetails(roomVal, actPax) {
  if (!roomVal || roomVal === '—') return { isRoomChange: false, displayRooms: '—', roomBadgeHtml: '' };

  const isTrueRoomChange = roomVal.includes('➔') || roomVal.toLowerCase().includes('changed on');

  if (isTrueRoomChange) {
    return {
      isRoomChange: true,
      displayRooms: roomVal,
      roomBadgeHtml: `<span class="type-badge" style="background:rgba(187,128,255,0.15);color:#d2a8ff;border:1px solid rgba(187,128,255,0.4);text-transform:none;margin-left:4px;display:inline-flex;align-items:center;gap:4px">🔄 Room Change: ${escapeHtml(roomVal)}</span>`
    };
  }

  return {
    isRoomChange: false,
    displayRooms: roomVal,
    roomBadgeHtml: `<span class="type-badge" style="background:var(--yellow-bg);color:var(--yellow);border:1px solid rgba(210,153,34,0.3);text-transform:none;margin-left:4px;display:inline-flex;align-items:center;gap:4px">🚪 Room: ${escapeHtml(String(roomVal))}</span>`
  };
}

// ── Build a single booking card ─────────────────────────────────────────────
function buildBookingCard(booking, idx) {
  const id = `booking-${idx}`;
  const rowData = booking.row || [];
  const name = rowData[3] || '—'; // Customer Name
  const code = rowData[1] || '—'; // CODE
  const pic = rowData[2] || '—'; // PIC
  const checkIn = rowData[7] || '—';
  const checkOut = rowData[8] || '—';

  // Find ROOM, ROOM_PAX, ROW_COLOR and REMARK indices dynamically from bookingsHeaders
  const roomIndex = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');
  const roomPaxIndex = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM_PAX');
  const colorIndex = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROW_COLOR');
  const remarkIndex = bookingsHeaders.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
  const specialReqIndex = bookingsHeaders.findIndex(h => h && ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'SPECIAL REQUESTS', 'REQUEST'].includes(h.toString().trim().toUpperCase()));
  
  const roomVal = roomIndex !== -1 ? (rowData[roomIndex] || '—') : '—';
  const rowColor = colorIndex !== -1 ? (rowData[colorIndex] || 'WHITE') : 'WHITE';
  const remarkVal = remarkIndex !== -1 ? (rowData[remarkIndex] || '') : (rowData[22] || '');
  const specialReqVal = specialReqIndex !== -1 ? (rowData[specialReqIndex] || '') : (rowData[13] || '');

  // Smart Pax Calculation: Prioritize activity pax (snorkellers + divers + course)
  const actPax = getRowActivityPaxClient(rowData);
  let cardPax = actPax > 0 ? actPax : 0;
  if (!cardPax && roomPaxIndex !== -1 && rowData[roomPaxIndex] && rowData[roomPaxIndex] !== '—') {
    const parsed = parsePaxString(rowData[roomPaxIndex].toString());
    cardPax = parsed > 0 ? parsed : 0;
  }
  if (!cardPax && booking.pax) {
    cardPax = booking.pax;
  }
  if (!cardPax) {
    cardPax = 1;
  }

  const roomInfo = parseRoomDetails(roomVal, actPax || cardPax);

  // Determine status badge and border styling based on remark keywords and row color
  let remarkBadge = '';
  let cardLeftBorder = 'var(--accent)';
  let titleRemarkInfo = '';

  const isRowWhite = isColorWhite(rowColor);
  const combinedRemark = `${remarkVal} ${specialReqVal}`.trim();
  const lowerRemark = combinedRemark.toLowerCase();
  const isCancelled = lowerRemark.includes('cancel') || lowerRemark.includes('cancle') || lowerRemark.includes('cancled') || lowerRemark.includes('cancelled');

  // Special remark check (cancel, postpone, double code, duplicate, etc.)
  const isSpecialRemark = isCancelled ||
                         lowerRemark.includes('postpone') || lowerRemark.includes('postponed') ||
                         lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged') ||
                         lowerRemark.includes('double') || lowerRemark.includes('dup');

  if (isRowWhite || isCancelled) {
    if (isSpecialRemark && combinedRemark) {
      let icon = '';
      let badgeText = '';
      let badgeBg = 'var(--red-bg)';
      let badgeColor = 'var(--red)';
      let badgeBorder = 'rgba(248,81,73,0.3)';

      if (isCancelled) {
        icon = '❌ ';
        badgeText = '❌ Cancelled';
        cardLeftBorder = 'var(--red)';
      } else if (lowerRemark.includes('postpone') || lowerRemark.includes('postponed')) {
        icon = '⏳ ';
        badgeText = '⏳ Postponed';
      } else if (lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged')) {
        icon = '🔄 ';
        badgeText = '🔄 Changed';
      } else if (lowerRemark.includes('double') || lowerRemark.includes('dup')) {
        icon = '⚠️ ';
        badgeText = '⚠️ Double Code';
      }

      if (badgeText) {
        remarkBadge = `<span class="type-badge" style="background:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder};text-transform:none;margin-left:4px;display:inline-flex;align-items:center;gap:4px">${badgeText}</span>`;
      }

      let displayRemarkText = remarkVal.toString().trim();
      const lowerRemarkOnly = remarkVal.toString().toLowerCase();
      const lowerSpecialOnly = specialReqVal.toString().toLowerCase();
      const isSpecialInRemark = lowerRemarkOnly.includes('cancel') || lowerRemarkOnly.includes('cancle') || lowerRemarkOnly.includes('cancled') || lowerRemarkOnly.includes('cancelled') || lowerRemarkOnly.includes('postpone') || lowerRemarkOnly.includes('postponed') || lowerRemarkOnly.includes('change') || lowerRemarkOnly.includes('changed') || lowerRemarkOnly.includes('chage') || lowerRemarkOnly.includes('chaged') || lowerRemarkOnly.includes('double') || lowerRemarkOnly.includes('dup');
      const isSpecialInReq = lowerSpecialOnly.includes('cancel') || lowerSpecialOnly.includes('cancle') || lowerSpecialOnly.includes('cancled') || lowerSpecialOnly.includes('cancelled') || lowerSpecialOnly.includes('postpone') || lowerSpecialOnly.includes('postponed') || lowerSpecialOnly.includes('change') || lowerSpecialOnly.includes('changed') || lowerSpecialOnly.includes('chage') || lowerSpecialOnly.includes('chaged') || lowerSpecialOnly.includes('double') || lowerSpecialOnly.includes('dup');

      if (isSpecialInRemark) {
        displayRemarkText = remarkVal.toString().trim();
      } else if (isSpecialInReq) {
        displayRemarkText = specialReqVal.toString().trim();
      } else {
        displayRemarkText = remarkVal.toString().trim() || specialReqVal.toString().trim();
      }

      titleRemarkInfo = `<span style="font-size:0.85rem;color:var(--text-secondary);font-weight:normal;margin-left:8px">${icon}• ${escapeHtml(displayRemarkText)}</span>`;
    }
  } else {
    // Row is colored. We ignore the remark and use the sheet color directly.
    cardLeftBorder = rowColor;
  }

  // Fields requested by user to display in detail table
  const fields = [
    { key: 'CODE', val: rowData[1] },
    { key: 'PIC', val: rowData[2] },
    { key: 'NAME', val: rowData[3] },
    { key: 'ROOM ASSIGNED', val: roomInfo.isRoomChange ? roomInfo.displayRooms : roomVal },
    { key: 'ROOM GUESTS (PAX)', val: cardPax },
    { key: 'SNORKELLING', val: rowData[4] },
    { key: 'DIVING', val: rowData[5] },
    { key: 'COURSE', val: rowData[6] },
    { key: 'CHECK IN', val: rowData[7] },
    { key: 'CHECK OUT', val: rowData[8] },
    { key: 'STAYING DAYS', val: rowData[9] },
    { key: 'ROOM TYPE', val: rowData[10] },
    { key: 'SHARING', val: rowData[11] },
    { key: 'BED', val: rowData[12] },
    { key: 'SPECIAL REQUEST', val: rowData[13] },
    { key: 'REMARK', val: remarkVal },
  ];

  // RBAC: ONLY Admin will see payment details (hidden from operator and jetty_staff)
  const canSeePayments = currentUser && currentUser.role === 'admin';
  if (canSeePayments) {
    const totalIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'TOTAL AMOUNT');
    const depositIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'DEPOSIT');
    const balanceIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'BALANCE');
    const statusIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'STATUS');

    const totalVal = totalIdx !== -1 ? rowData[totalIdx] : (rowData[18] || '');
    const depositVal = depositIdx !== -1 ? rowData[depositIdx] : (rowData[19] || '');
    const balanceVal = balanceIdx !== -1 ? rowData[balanceIdx] : (rowData[20] || '');
    const statusVal = statusIdx !== -1 ? rowData[statusIdx] : (rowData[21] || '');

    if (totalVal) fields.push({ key: 'TOTAL AMOUNT', val: totalVal });
    if (depositVal) fields.push({ key: 'DEPOSIT', val: depositVal });
    if (balanceVal) fields.push({ key: 'BALANCE', val: balanceVal });
    if (statusVal) fields.push({ key: 'PAYMENT STATUS', val: statusVal });
  }

  const rows = fields
    .map(f => {
      const val = (f.val || '').toString().trim();
      if (!val) return '';
      return `<tr><td style="color:var(--text-secondary);width:35%">${escapeHtml(f.key)}</td><td>${escapeHtml(val)}</td></tr>`;
    })
    .filter(Boolean)
    .join('');

  const overrideBadge = booking.isOverridden
    ? `<span class="type-badge" style="background:rgba(113, 221, 25, 0.38);color:#e3b341;border:1px solid rgba(209, 82, 9, 0.4)" title="Edited on Dashboard">✏️ Edited</span>`
    : '';

  const revertBtn = (currentUser && currentUser.role === 'admin' && booking.isOverridden)
    ? `<button class="action-btn" onclick="revertBookingOverrideDirect('${escapeHtml(String(booking.overrideMeta?.bookingKey || ''))}', ${booking.rowIndex !== undefined ? booking.rowIndex : idx}, event)" style="background:rgba(248,81,73,0.15);color:var(--red);border-color:rgba(248,81,73,0.4);font-weight:600">↩️ Revert to Sheet</button>`
    : '';

  const cardActionBar = `
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <button class="action-btn" onclick="copyBookingDetails(${booking.rowIndex !== undefined ? booking.rowIndex : idx}, event)" style="background:var(--bg-primary);color:var(--text-primary);border-color:var(--border);font-weight:600">📋 Copy Details</button>
      ${revertBtn}
      ${(currentUser && currentUser.role === 'admin')
        ? `<button class="action-btn" onclick="openEditBookingModalByIndex(${booking.rowIndex !== undefined ? booking.rowIndex : idx}, '${escapeHtml(String(code))}')" style="background:var(--accent-glow);color:var(--accent);border-color:rgba(88,166,255,0.4);font-weight:600">✏️ Edit Booking Details</button>`
        : ''}
    </div>`;

  return `
    <div class="change-card" id="${id}" style="border-left: 3px solid ${cardLeftBorder}">
      <div class="card-header" onclick="toggleCard('${id}')">
        <div class="card-left">
          <span class="type-badge" onclick="copyTextToClipboard('${escapeHtml(String(code))}', 'Code ${escapeHtml(String(code))} copied!')" title="Click to copy code" style="background:var(--accent-glow);color:var(--accent);border:1px solid rgba(88,166,255,0.3);cursor:pointer">${escapeHtml(String(code))}</span>
          <span class="card-title">${escapeHtml(String(name))}${titleRemarkInfo}</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">(${escapeHtml(String(pic))})</span>
          ${roomVal && roomVal !== '—' ? roomInfo.roomBadgeHtml : ''}
          ${remarkBadge}
          ${overrideBadge}
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="type-badge" style="background:var(--green-bg);color:var(--green);border:1px solid rgba(63,185,80,0.3);text-transform:none;display:inline-flex;align-items:center;gap:4px">👤 ${escapeHtml(String(cardPax))} Pax</span>
          <span class="card-time" style="color:var(--text-secondary)">${escapeHtml(String(checkIn))} → ${escapeHtml(String(checkOut))}</span>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="card-body">
        <table class="row-table" style="margin-top:12px">
          <thead><tr><th>Column</th><th>Value</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="2" style="color:var(--text-muted)">No data</td></tr>'}</tbody>
        </table>
        ${cardActionBar}
      </div>
    </div>`;
}

function toggleCard(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Scroll to Top ───────────────────────────────────────────────────────────
window.addEventListener('scroll', () => {
  const btn = document.getElementById('scroll-to-top-btn');
  if (btn) {
    if (window.scrollY > 300) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  }
});

function scrollToTop() {
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
}

// ── PWA Installation & Service Worker Registration ─────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('Service Worker registered successfully:', reg.scope))
      .catch((err) => console.error('Service Worker registration failed:', err));
  });
}

let deferredPrompt;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent the mini-infobar from appearing on mobile
  e.preventDefault();
  // Stash the event so it can be triggered later.
  deferredPrompt = e;
  // Update UI notify the user they can install the PWA
  if (installBtn) {
    installBtn.style.display = 'flex';
  }
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    // Show the install prompt
    deferredPrompt.prompt();
    // Wait for the user to respond to the prompt
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User response to the install prompt: ${outcome}`);
    // We've used the prompt, and can't use it again
    deferredPrompt = null;
    // Hide the install button
    installBtn.style.display = 'none';
  });
}

window.addEventListener('appinstalled', (evt) => {
  console.log('Sheets Monitor Bot app was successfully installed!');
  if (installBtn) {
    installBtn.style.display = 'none';
  }
  showToast('🎉 App installed successfully!');
});



// ── Render In-House Guests List View ─────────────────────────────────────────
function renderInHouseList(container, searchQuery, targetDateInput, badgeCountEl) {
  const tDate = targetDateInput ? new Date(targetDateInput) : new Date();
  tDate.setHours(0, 0, 0, 0);

  const bookingsList = (allBookings && allBookings.length > 0) ? allBookings : currentBookings;
  const roomPaxIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM_PAX');
  const roomIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');
  const checkInIdx = bookingsHeaders.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
  const checkOutIdx = bookingsHeaders.findIndex(h => h && ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'].includes(h.toString().trim().toUpperCase()));
  const remarkIdx = bookingsHeaders.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
  const specialReqIdx = bookingsHeaders.findIndex(h => h && ['SPECIAL REQUEST', 'SPECIAL_REQUEST', 'SPECIAL REQUESTS', 'REQUEST'].includes(h.toString().trim().toUpperCase()));
  const codeIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
  const nameIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'NAME');

  const bookingsByCode = {};

  bookingsList.forEach((item, index) => {
    const rowData = item.row || [];
    const remarkVal = (remarkIdx !== -1 ? (rowData[remarkIdx] || '') : (rowData[22] || '')).toString().toLowerCase();
    const specialReqVal = (specialReqIdx !== -1 ? (rowData[specialReqIdx] || '') : (rowData[13] || '')).toString().toLowerCase();
    const combinedVal = `${remarkVal} ${specialReqVal}`;

    if (combinedVal.includes('cancel') || combinedVal.includes('cancle') || combinedVal.includes('cancelled') || combinedVal.includes('postpone') || combinedVal.includes('postponed')) {
      return;
    }

    const checkIn = parseClientDate(rowData[checkInIdx !== -1 ? checkInIdx : 7]);
    const checkOut = parseClientDate(rowData[checkOutIdx !== -1 ? checkOutIdx : 8]);
    if (!checkIn) return;

    const cIn = new Date(checkIn); cIn.setHours(0, 0, 0, 0);
    let cOut = checkOut ? new Date(checkOut) : new Date(cIn); cOut.setHours(0, 0, 0, 0);

    let isInHouse = false;
    if (cOut > cIn) {
      isInHouse = (tDate >= cIn && tDate < cOut);
    } else {
      isInHouse = (tDate.getTime() === cIn.getTime());
    }

    if (isInHouse) {
      const rawCode = (codeIdx !== -1 && rowData[codeIdx]) ? rowData[codeIdx].toString().trim().toUpperCase() : '';
      const rIndex = item.rowIndex || index + 1;
      const codeKey = rawCode ? `${rawCode}_${rIndex}` : `ROW_${rIndex}`;

      if (!bookingsByCode[codeKey]) {
        bookingsByCode[codeKey] = {
          code: rawCode,
          name: (nameIdx !== -1 && rowData[nameIdx]) ? rowData[nameIdx].toString().trim() : '',
          row: rowData,
          rowIndex: rIndex,
          totalActivityPax: 0,
          roomPax: 0,
          roomStr: (roomIdx !== -1 && rowData[roomIdx]) ? rowData[roomIdx].toString().trim() : '—'
        };
      }

      bookingsByCode[codeKey].totalActivityPax = Math.max(bookingsByCode[codeKey].totalActivityPax, getRowActivityPaxClient(rowData));
      if (roomPaxIdx !== -1 && rowData[roomPaxIdx] && rowData[roomPaxIdx] !== '—') {
        const parsedPax = parsePaxString(rowData[roomPaxIdx].toString());
        if (parsedPax > 0 && bookingsByCode[codeKey].roomPax === 0) {
          bookingsByCode[codeKey].roomPax = parsedPax;
        }
      }
    }
  });

  const list = [];
  let totalPax = 0;

  for (const key in bookingsByCode) {
    const group = bookingsByCode[key];
    let pax = 1;
    if (group.totalActivityPax > 0) {
      pax = group.totalActivityPax;
    } else if (group.roomPax > 0) {
      pax = group.roomPax;
    }

    const rowData = group.row;
    const code = group.code;
    const name = group.name;
    const checkIn = (checkInIdx !== -1 ? rowData[checkInIdx] : rowData[7]) || '—';
    const checkOut = (checkOutIdx !== -1 ? rowData[checkOutIdx] : rowData[8]) || '—';
    const stayDays = rowData[9] || '—';
    const snork = rowData[4] || '';
    const dive = rowData[5] || '';
    const course = rowData[6] || '';

    // Search filter check
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchCode = code.toLowerCase().includes(q);
      const matchName = name.toLowerCase().includes(q);
      const matchCheckIn = checkIn.toLowerCase().includes(q);
      const matchCheckOut = checkOut.toLowerCase().includes(q);
      const matchRoom = group.roomStr.toLowerCase().includes(q);
      if (!matchCode && !matchName && !matchCheckIn && !matchCheckOut && !matchRoom) {
        continue;
      }
    }

    totalPax += pax;
    list.push({
      rowIndex: group.rowIndex,
      code: code || '—',
      name: name || 'Unassigned',
      checkIn,
      checkOut,
      stayDays,
      snork,
      dive,
      course,
      roomStr: group.roomStr,
      pax
    });
  }

  const dateFormatted = tDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const isToday = isSameDay(tDate, new Date());
  const dateTag = isToday ? `Today (${dateFormatted})` : dateFormatted;

  if (badgeCountEl) badgeCountEl.textContent = `${totalPax} In-House Pax (${list.length} Bookings)`;

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🏠</div>
        <h3>No In-House Guests Found for ${dateTag}</h3>
        <p>Try picking another date using the Check-In filter or search bar.</p>
      </div>`;
    return;
  }

  let html = `
    <div class="inhouse-summary-bar">
      <div>
        <span style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">🏠 In-House Guests Breakdown</span>
        <span style="font-size: 0.85rem; color: var(--text-secondary); margin-left: 8px;">Date: <strong style="color: var(--accent);">${dateTag}</strong></span>
      </div>
      <div style="display: flex; gap: 10px; align-items: center;">
        <span class="badge" style="background: var(--green-bg); color: var(--green); border: 1px solid rgba(63,185,80,0.3); font-size: 0.9rem; font-weight: 700; padding: 6px 14px;">
          👥 ${totalPax} Total Guests (Pax)
        </span>
        <span class="badge" style="background: var(--accent-glow); color: var(--accent); border: 1px solid rgba(88,166,255,0.3); font-size: 0.85rem; font-weight: 600; padding: 6px 12px;">
          📋 ${list.length} Active Bookings
        </span>
      </div>
    </div>

    <div style="overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--border);">
      <table class="inhouse-table">
        <thead>
          <tr>
            <th style="width: 40px; text-align: center;">#</th>
            <th style="width: 60px;">Row</th>
            <th style="width: 70px;">Code</th>
            <th>Customer Name</th>
            <th style="width: 140px;">Stay Dates</th>
            <th style="width: 120px;">Activities</th>
            <th>Assigned Rooms</th>
            <th style="width: 90px; text-align: right;">In-House Pax</th>
          </tr>
        </thead>
        <tbody>
  `;

  list.forEach((item, i) => {
    const actParts = [];
    if (item.snork) actParts.push(`🤿 ${item.snork}`);
    if (item.dive) actParts.push(`🏊 ${item.dive}`);
    if (item.course) actParts.push(`📚 ${item.course}`);
    const actStr = actParts.length > 0 ? actParts.join('<br>') : '—';

    html += `
      <tr>
        <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem;">${i + 1}</td>
        <td style="color: var(--text-secondary); font-family: monospace; font-size: 0.8rem;">#${item.rowIndex}</td>
        <td><code style="background: var(--bg-primary); padding: 2px 6px; border-radius: 4px; color: var(--accent); font-weight: 600;">${item.code}</code></td>
        <td style="font-weight: 600; color: var(--text-primary);">${item.name}</td>
        <td style="font-size: 0.8rem; color: var(--text-secondary);">${item.checkIn} &rarr; ${item.checkOut}<br><span style="color: var(--text-muted); font-size: 0.75rem;">(${item.stayDays})</span></td>
        <td style="font-size: 0.8rem;">${actStr}</td>
        <td style="font-size: 0.82rem; color: var(--text-primary); font-weight: 500;">${item.roomStr}</td>
        <td style="text-align: right;"><span class="badge" style="background: var(--green-bg); color: var(--green); border: 1px solid rgba(63,185,80,0.3); font-weight: 700;">${item.pax} Pax</span></td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
}

// ── Authentication & Admin Control Center Logic ─────────────────────────────

function togglePasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (btnEl) btnEl.textContent = '🙈';
  } else {
    input.type = 'password';
    if (btnEl) btnEl.textContent = '👁️';
  }
}

function showAuthOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function hideAuthOverlay() {
  const overlay = document.getElementById('auth-overlay');
  if (overlay) overlay.style.display = 'none';
}

function showAuthView(viewName) {
  const loginView = document.getElementById('login-card-view');
  const regView = document.getElementById('register-card-view');
  const pendingView = document.getElementById('pending-card-view');

  if (loginView) loginView.style.display = viewName === 'login' ? 'block' : 'none';
  if (regView) regView.style.display = viewName === 'register' ? 'block' : 'none';
  if (pendingView) pendingView.style.display = viewName === 'pending' ? 'block' : 'none';
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const nameInp = document.getElementById('reg-name');
  const userInp = document.getElementById('reg-username');
  const emailInp = document.getElementById('reg-email');
  const pwdInp = document.getElementById('reg-password');
  const errorBox = document.getElementById('register-error');
  const submitBtn = document.getElementById('reg-submit-btn');

  if (!nameInp || !userInp || !emailInp || !pwdInp) return;
  errorBox.style.display = 'none';

  const password = pwdInp.value;
  if (!/\d/.test(password) || !/[A-Z]/.test(password)) {
    errorBox.textContent = 'Password must contain at least 1 capital letter (A-Z) and 1 number (0-9).';
    errorBox.style.display = 'block';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Registering...';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: nameInp.value.trim(),
        username: userInp.value.trim(),
        email: emailInp.value.trim(),
        password
      })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showAuthView('pending');
    } else {
      errorBox.textContent = data.error || 'Registration failed.';
      errorBox.style.display = 'block';
    }
  } catch (err) {
    errorBox.textContent = 'Network error during registration.';
    errorBox.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Register Account ➔';
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorBox = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit-btn');

  if (!usernameInput || !passwordInput) return;
  errorBox.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value
      })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      // 30-Day TTL session storage
      const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
      localStorage.setItem('sheets_auth_token', data.token);
      localStorage.setItem('sheets_auth_expires', expiresAt.toString());

      currentUser = data.user;
      hideAuthOverlay();
      setupUserUI(data.user);
      await loadData(true);
      showToast(`👋 Welcome back, ${data.user.displayName}!`);
    } else {
      if (data.error && data.error.includes('PENDING_APPROVAL')) {
        showAuthView('pending');
      } else {
        errorBox.textContent = data.error || 'Login failed. Please check your credentials.';
        errorBox.style.display = 'block';
      }
    }
  } catch (err) {
    errorBox.textContent = 'Network error connecting to auth server.';
    errorBox.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In ➔';
  }
}

async function checkAuth() {
  const token = localStorage.getItem('sheets_auth_token');
  const expiresStr = localStorage.getItem('sheets_auth_expires');

  if (!token || !expiresStr) {
    showAuthOverlay();
    showAuthView('login');
    return;
  }

  // Check 30-day TTL expiration
  if (Date.now() > parseInt(expiresStr, 10)) {
    localStorage.removeItem('sheets_auth_token');
    localStorage.removeItem('sheets_auth_expires');
    showAuthOverlay();
    showAuthView('login');
    return;
  }

  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentUser = data.user;
      hideAuthOverlay();
      setupUserUI(data.user);
      loadData();
    } else {
      localStorage.removeItem('sheets_auth_token');
      localStorage.removeItem('sheets_auth_expires');
      showAuthOverlay();
      showAuthView('login');
    }
  } catch {
    showAuthOverlay();
    showAuthView('login');
  }
}

function setupUserUI(user) {
  const badge = document.getElementById('user-profile-badge');
  const roleTag = document.getElementById('user-role-tag');
  const nameLabel = document.getElementById('user-display-name');
  const adminBtn = document.getElementById('admin-portal-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const triggerBtn = document.getElementById('trigger-btn');
  const tabChangelog = document.getElementById('tab-changelog');
  const tabBookings = document.getElementById('tab-bookings');
  const tabInhouse = document.getElementById('tab-inhouse');
  const tabAllBookings = document.getElementById('tab-allbookings');

  if (badge) badge.style.display = 'flex';
  if (logoutBtn) logoutBtn.style.display = 'inline-flex';

  const userRole = (user && user.role) ? user.role : 'operator';

  if (roleTag) {
    if (userRole === 'admin') {
      roleTag.textContent = 'ADMIN';
      roleTag.style.background = 'var(--red-bg)';
      roleTag.style.color = 'var(--red)';
      roleTag.style.border = '1px solid rgba(248,81,73,0.3)';
    } else if (userRole === 'jetty_staff') {
      roleTag.textContent = 'JETTY STAFF';
      roleTag.style.background = 'rgba(45, 212, 191, 0.15)';
      roleTag.style.color = '#2dd4bf';
      roleTag.style.border = '1px solid rgba(45, 212, 191, 0.4)';
    } else {
      roleTag.textContent = 'OPERATOR';
      roleTag.style.background = 'var(--accent-glow)';
      roleTag.style.color = 'var(--accent)';
      roleTag.style.border = '1px solid rgba(88, 166, 255, 0.3)';
    }
  }

  if (nameLabel) nameLabel.textContent = user.displayName || user.username;
  if (adminBtn) adminBtn.style.display = userRole === 'admin' ? 'inline-flex' : 'none';

  // Role-based visibility for Tabs, Actions & Stat Cards
  const statsGrid = document.querySelector('.stats-grid');
  if (userRole === 'jetty_staff') {
    if (tabChangelog) tabChangelog.style.display = 'none';
    if (tabInhouse) tabInhouse.style.display = 'none';
    if (tabAllBookings) tabAllBookings.style.display = 'none';
    if (triggerBtn) triggerBtn.style.display = 'none';

    // Hide Change Log category filter bar
    const filterBar = document.getElementById('category-filters');
    if (filterBar) filterBar.style.display = 'none';

    // Hide top stat cards blocks completely for jetty staff
    if (statsGrid) statsGrid.style.display = 'none';

    // Default to Current Bookings tab
    if (activeTab !== 'bookings') {
      setTab('bookings');
    }
  } else {
    // Admin and Operator see all tabs and full controls
    if (tabChangelog) tabChangelog.style.display = '';
    if (tabInhouse) tabInhouse.style.display = '';
    if (tabAllBookings) tabAllBookings.style.display = '';
    if (triggerBtn) triggerBtn.style.display = 'inline-flex';

    if (statsGrid) statsGrid.style.display = '';

    const statNewCard = document.getElementById('stat-new')?.closest('.stat-card');
    const statModCard = document.getElementById('stat-modified')?.closest('.stat-card');
    const statErrCard = document.getElementById('stat-errors')?.closest('.stat-card');
    if (statNewCard) statNewCard.style.display = '';
    if (statModCard) statModCard.style.display = '';
    if (statErrCard) statErrCard.style.display = '';

    const statTotalCard = document.getElementById('stat-total')?.closest('.stat-card');
    if (statTotalCard) {
      const lbl = statTotalCard.querySelector('.stat-label');
      const sub = statTotalCard.querySelector('.stat-sub');
      if (lbl) lbl.textContent = 'Total Checks';
      if (sub) sub.textContent = 'Since bot started';
    }
  }
}

async function logoutUser() {
  try {
    await authFetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  localStorage.removeItem('sheets_auth_token');
  localStorage.removeItem('sheets_auth_expires');
  currentUser = null;
  location.reload();
}

// ── Admin Portal Tabs & Actions ─────────────────────────────────────────────

function openAdminPortal() {
  if (!currentUser || currentUser.role !== 'admin') {
    showToast('❌ Admin privileges required.');
    return;
  }
  const modal = document.getElementById('admin-modal');
  if (modal) {
    modal.style.display = 'flex';
    setAdminTab('users');
  }
}

function closeAdminPortal() {
  const modal = document.getElementById('admin-modal');
  if (modal) modal.style.display = 'none';
}

function setAdminTab(tabName) {
  const tabs = ['users', 'bot', 'tg', 'data', 'telem', 'audit', 'boat'];
  tabs.forEach(t => {
    const btn = document.getElementById(`adm-tab-${t}`);
    const panel = document.getElementById(`adm-panel-${t}`);
    if (btn) btn.classList.toggle('active', t === tabName);
    if (panel) panel.style.display = t === tabName ? 'block' : 'none';
  });

  if (tabName === 'users') loadAdminUsers();
  else if (tabName === 'bot') loadBotSettingsUI();
  else if (tabName === 'telem') loadTelemetryData();
  else if (tabName === 'audit') loadAuditLogsUI();
  else if (tabName === 'boat') initBoatReportUI();
}


// ── Admin: User Management ──
async function loadAdminUsers() {
  const pendingTbody = document.getElementById('adm-pending-users-tbody');
  const activeTbody = document.getElementById('adm-users-tbody');
  const pendingBadge = document.getElementById('pending-users-count-badge');

  if (pendingTbody) pendingTbody.innerHTML = '<tr><td colspan="4" style="padding: 12px; text-align: center;">Loading...</td></tr>';
  if (activeTbody) activeTbody.innerHTML = '<tr><td colspan="5" style="padding: 12px; text-align: center;">Loading...</td></tr>';

  try {
    const res = await authFetch('/api/admin/users');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const users = data.users || [];
    const pendingUsers = users.filter(u => u.approved === false);
    const activeUsers = users.filter(u => u.approved !== false);

    if (pendingBadge) {
      pendingBadge.textContent = `${pendingUsers.length} Pending`;
      pendingBadge.style.background = pendingUsers.length > 0 ? 'var(--yellow-bg)' : 'var(--bg-primary)';
    }

    // Render Pending Approvals
    let pendingHtml = '';
    pendingUsers.forEach(u => {
      pendingHtml += `
        <tr style="border-bottom: 1px solid var(--border-light); background: rgba(210,153,34,0.03);">
          <td style="padding: 10px; font-weight: 600;">${escapeHtml(u.username)}</td>
          <td style="padding: 10px; color: var(--text-primary);">${escapeHtml(u.displayName || '—')}</td>
          <td style="padding: 10px; font-size:0.78rem; color: var(--text-muted);">${new Date(u.createdAt).toLocaleDateString()}</td>
          <td style="padding: 10px; text-align: right; display: flex; gap: 6px; justify-content: flex-end; align-items: center;">
            <select id="pending-role-${u.id}" class="search-input-field" style="padding: 4px 8px; font-size: 0.75rem; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary);">
              <option value="operator" selected>Operator</option>
              <option value="jetty_staff">Jetty Staff</option>
              <option value="admin">Admin</option>
            </select>
            <button class="action-btn" onclick="approveUserAccount('${u.id}', '${escapeHtml(u.username)}')" style="background:var(--green-bg); color:var(--green); border-color:rgba(63,185,80,0.3); font-size:0.78rem; padding:5px 10px; font-weight:600;">✓ Approve</button>
            <button class="action-btn" onclick="deleteUserAccount('${u.id}', '${escapeHtml(u.username)}')" style="background:var(--red-bg); color:var(--red); border-color:rgba(248,81,73,0.3); font-size:0.75rem; padding:4px 8px;">Reject</button>
          </td>
        </tr>
      `;
    });
    if (pendingTbody) pendingTbody.innerHTML = pendingHtml || '<tr><td colspan="4" style="padding: 14px; text-align: center; color: var(--text-muted);">No pending registration requests.</td></tr>';

    // Render Active Users
    let activeHtml = '';
    activeUsers.forEach(u => {
      const isSelf = u.id === currentUser.id;
      let roleHtml = '';
      if (isSelf || u.isSeed) {
        let badgeStyle = 'background:var(--accent-glow);color:var(--accent);';
        if (u.role === 'admin') badgeStyle = 'background:var(--red-bg);color:var(--red);';
        if (u.role === 'jetty_staff') badgeStyle = 'background:rgba(45,212,191,0.15);color:#2dd4bf;';
        roleHtml = `<span class="badge" style="font-size:0.7rem; text-transform:uppercase; ${badgeStyle}">${escapeHtml(u.role)}</span>`;
      } else {
        roleHtml = `
          <select class="search-input-field" onchange="changeUserRole('${u.id}', this.value, '${escapeHtml(u.username)}')" style="padding: 3px 6px; font-size: 0.75rem; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); cursor: pointer;">
            <option value="operator" ${u.role === 'operator' ? 'selected' : ''}>Operator</option>
            <option value="jetty_staff" ${u.role === 'jetty_staff' ? 'selected' : ''}>Jetty Staff</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        `;
      }

      activeHtml += `
        <tr style="border-bottom: 1px solid var(--border-light);">
          <td style="padding: 10px; font-weight: 600;">${escapeHtml(u.username)} ${u.isSeed ? '<span class="badge" style="font-size:0.65rem;">SEED</span>' : ''}</td>
          <td style="padding: 10px; color: var(--text-secondary);">${escapeHtml(u.displayName || '—')}</td>
          <td style="padding: 10px;">${roleHtml}</td>
          <td style="padding: 10px; font-size:0.78rem; color: var(--text-muted);">${new Date(u.createdAt).toLocaleDateString()}</td>
          <td style="padding: 10px; text-align: right;">
            ${isSelf ? '<span style="font-size:0.75rem; color:var(--text-muted);">Active Session</span>' : `<button class="action-btn" onclick="deleteUserAccount('${u.id}', '${escapeHtml(u.username)}')" style="background:var(--red-bg); color:var(--red); border-color:rgba(248,81,73,0.3); font-size:0.75rem; padding:4px 8px;">Delete</button>`}
          </td>
        </tr>
      `;
    });
    if (activeTbody) activeTbody.innerHTML = activeHtml || '<tr><td colspan="5" style="padding: 16px; text-align: center;">No active users found.</td></tr>';

  } catch (err) {
    if (activeTbody) activeTbody.innerHTML = `<tr><td colspan="5" style="padding: 16px; text-align: center; color: var(--red);">Error: ${err.message}</td></tr>`;
  }
}

async function approveUserAccount(userId, username) {
  const roleSelect = document.getElementById(`pending-role-${userId}`);
  const role = roleSelect ? roleSelect.value : 'operator';
  try {
    const res = await authFetch(`/api/admin/users/${userId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Approved account for ${username} (${role})`);
      loadAdminUsers();
    } else {
      showToast(`❌ ${data.error || 'Approval failed'}`);
    }
  } catch {
    showToast('❌ Network error approving user account.');
  }
}

async function changeUserRole(userId, newRole, username) {
  try {
    const res = await authFetch(`/api/admin/users/${userId}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Role for ${username} changed to ${newRole}`);
      loadAdminUsers();
    } else {
      showToast(`❌ ${data.error || 'Failed to update role'}`);
      loadAdminUsers();
    }
  } catch {
    showToast('❌ Network error updating role.');
    loadAdminUsers();
  }
}

function toggleAddUserForm() {
  const card = document.getElementById('add-user-form-card');
  if (card) card.style.display = card.style.display === 'none' ? 'block' : 'none';
}

async function handleCreateUserSubmit(e) {
  e.preventDefault();
  const username = document.getElementById('new-user-username').value;
  const displayName = document.getElementById('new-user-display').value;
  const password = document.getElementById('new-user-password').value;
  const role = document.getElementById('new-user-role').value;

  try {
    const res = await authFetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName, password, role })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast(`✅ Created approved user ${username}`);
      toggleAddUserForm();
      loadAdminUsers();
    } else {
      showToast(`❌ ${data.error || 'Failed to create user'}`);
    }
  } catch (err) {
    showToast(`❌ Error creating user.`);
  }
}

async function deleteUserAccount(userId, username) {
  if (!confirm(`Are you sure you want to delete user account "${username}"?`)) return;
  try {
    const res = await authFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🗑️ User ${username} deleted.`);
      loadAdminUsers();
    } else {
      showToast(`❌ ${data.error || 'Delete failed'}`);
    }
  } catch {
    showToast('❌ Network error deleting user.');
  }
}

// ── Admin: Bot Settings & Quiet Hours ──
async function loadBotSettingsUI() {
  try {
    const res = await authFetch('/api/admin/bot/settings');
    const data = await res.json();
    if (!res.ok) return;

    const cfg = data.config || {};
    const pauseBtn = document.getElementById('bot-pause-toggle-btn');
    if (pauseBtn) {
      pauseBtn.textContent = cfg.isPaused ? '▶️ Resume Bot' : '⏸ Pause Bot';
      pauseBtn.style.background = cfg.isPaused ? 'var(--green-bg)' : 'var(--red-bg)';
      pauseBtn.style.color = cfg.isPaused ? 'var(--green)' : 'var(--red)';
    }

    const startInp = document.getElementById('qh-start');
    const endInp = document.getElementById('qh-end');
    const snoozeInp = document.getElementById('qh-snooze');

    if (startInp) startInp.value = cfg.quietHoursStart ?? 23;
    if (endInp) endInp.value = cfg.quietHoursEnd ?? 7;
    if (snoozeInp) snoozeInp.value = cfg.snoozeHours ?? 6;

    const nameInp = document.getElementById('brand-resort-name');
    const taglineInp = document.getElementById('brand-resort-tagline');
    const logoInp = document.getElementById('brand-logo-url');
    const primaryInp = document.getElementById('brand-primary-color');
    const primaryPicker = document.getElementById('brand-primary-color-picker');
    const accentInp = document.getElementById('brand-accent-color');
    const accentPicker = document.getElementById('brand-accent-color-picker');
    const jettyNameInp = document.getElementById('brand-jetty-name');
    const jettyMapInp = document.getElementById('brand-jetty-map-url');
    const assemblyInp = document.getElementById('brand-assembly-time');
    const departureInp = document.getElementById('brand-departure-time');
    const phoneInp = document.getElementById('brand-contact-phone');

    if (nameInp) nameInp.value = cfg.resortName || '';
    if (taglineInp) taglineInp.value = cfg.resortTagline || '';
    if (logoInp) logoInp.value = cfg.logoUrl || '';
    if (primaryInp) primaryInp.value = cfg.primaryColor || '#58a6ff';
    if (primaryPicker) primaryPicker.value = cfg.primaryColor || '#58a6ff';
    if (accentInp) accentInp.value = cfg.brandAccent || '#2ea043';
    if (accentPicker) accentPicker.value = cfg.brandAccent || '#2ea043';
    if (jettyNameInp) jettyNameInp.value = cfg.jettyName || '';
    if (jettyMapInp) jettyMapInp.value = cfg.jettyMapUrl || '';
    if (assemblyInp) assemblyInp.value = cfg.assemblyTime || '';
    if (departureInp) departureInp.value = cfg.departureTime || '';
    if (phoneInp) phoneInp.value = cfg.contactPhone || '';

    applyBrandingToUI(cfg);
  } catch {}
}

async function handleBrandingSubmit(e) {
  e.preventDefault();
  const resortName = document.getElementById('brand-resort-name')?.value;
  const resortTagline = document.getElementById('brand-resort-tagline')?.value;
  const logoUrl = document.getElementById('brand-logo-url')?.value;
  const primaryColor = document.getElementById('brand-primary-color')?.value;
  const brandAccent = document.getElementById('brand-accent-color')?.value;
  const jettyName = document.getElementById('brand-jetty-name')?.value;
  const jettyMapUrl = document.getElementById('brand-jetty-map-url')?.value;
  const assemblyTime = document.getElementById('brand-assembly-time')?.value;
  const departureTime = document.getElementById('brand-departure-time')?.value;
  const contactPhone = document.getElementById('brand-contact-phone')?.value;

  try {
    const res = await authFetch('/api/admin/bot/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resortName,
        resortTagline,
        logoUrl,
        primaryColor,
        brandAccent,
        jettyName,
        jettyMapUrl,
        assemblyTime,
        departureTime,
        contactPhone
      })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast('✅ Resort branding settings updated!');
      applyBrandingToUI(data.config);
    } else {
      showToast(`❌ ${data.error || 'Failed to save branding settings'}`);
    }
  } catch {
    showToast('❌ Error updating branding settings.');
  }
}

async function toggleBotPauseState() {
  try {
    const currentRes = await authFetch('/api/admin/bot/settings');
    const currentData = await currentRes.json();
    const isCurrentlyPaused = !!currentData.config?.isPaused;

    const res = await authFetch('/api/admin/bot/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPaused: !isCurrentlyPaused })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast(data.config.isPaused ? '⏸ Bot loop paused.' : '▶️ Bot loop resumed.');
      loadBotSettingsUI();
    }
  } catch {
    showToast('❌ Failed to toggle bot state.');
  }
}

async function handleQuietHoursSubmit(e) {
  e.preventDefault();
  const start = parseInt(document.getElementById('qh-start').value, 10);
  const end = parseInt(document.getElementById('qh-end').value, 10);
  const snooze = parseInt(document.getElementById('qh-snooze').value, 10);

  try {
    const res = await authFetch('/api/admin/bot/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quietHoursStart: start, quietHoursEnd: end, snoozeHours: snooze })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast('✅ Bot settings updated.');
    } else {
      showToast(`❌ ${data.error || 'Update failed'}`);
    }
  } catch {
    showToast('❌ Error updating quiet hours.');
  }
}

// ── Admin: Telegram Test Ping ──
async function sendTelegramTestPing(channelType) {
  try {
    const res = await authFetch('/api/admin/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelType })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message);
    } else {
      showToast(`❌ ${data.error || 'Ping failed'}`);
    }
  } catch {
    showToast('❌ Network error testing Telegram ping.');
  }
}

// ── Admin: Execute Telegram Bot Commands ──
async function executeAdminCommand(commandKey, btnEl) {
  const consoleEl = document.getElementById('adm-cmd-console');
  let originalBtnText = '';

  if (btnEl) {
    originalBtnText = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.innerHTML = '⏳ Executing...';
  }

  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  if (consoleEl) {
    if (consoleEl.innerHTML.includes('[Console Ready]') || consoleEl.innerHTML.includes('[Console Cleared]')) {
      consoleEl.innerHTML = '';
    }
    consoleEl.innerHTML += `<div style="color:#58a6ff; margin-bottom:4px;">[${timestamp}] 🚀 Executing command: /${commandKey}...</div>`;
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  showToast(`⏱ Executing /${commandKey}...`);

  try {
    const res = await authFetch('/api/admin/commands/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: commandKey })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      const msg = data.message || 'Command executed successfully.';
      showToast(`✅ /${commandKey}: Success!`);
      if (consoleEl) {
        consoleEl.innerHTML += `<div style="color:#3fb950; margin-bottom:6px;">[${timestamp}] ${msg}</div>`;
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }
    } else {
      const err = data.error || 'Failed to execute command';
      showToast(`❌ /${commandKey}: ${err}`);
      if (consoleEl) {
        consoleEl.innerHTML += `<div style="color:#f85149; margin-bottom:6px;">[${timestamp}] ❌ Error: ${err}</div>`;
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }
    }
  } catch (err) {
    showToast(`❌ Network error executing /${commandKey}`);
    if (consoleEl) {
      consoleEl.innerHTML += `<div style="color:#f85149; margin-bottom:6px;">[${timestamp}] ❌ Network Error: ${err.message || err}</div>`;
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = originalBtnText;
    }
  }
}

function clearAdminCommandConsole() {
  const consoleEl = document.getElementById('adm-cmd-console');
  if (consoleEl) {
    consoleEl.innerHTML = '<span style="color: #484f58;">[Console Cleared] Select any command button above to execute and view output details...</span>';
  }
}

// ── Admin: Data Export & Reset ──
function downloadExport(type, format) {
  const token = localStorage.getItem('sheets_auth_token');
  const url = `/api/admin/export/${type}?format=${format}&token=${encodeURIComponent(token)}`;
  window.open(url, '_blank');
}

async function triggerBaselineReset() {
  if (!confirm('Re-establish baseline snapshot from Google Sheets now?')) return;
  try {
    const res = await authFetch('/api/admin/snapshot/reset', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Baseline snapshot reset: ${data.message}`);
      loadData(true);
    } else {
      showToast(`❌ ${data.error || 'Reset failed'}`);
    }
  } catch {
    showToast('❌ Network error resetting baseline.');
  }
}

// ── Admin: Telemetry Diagnostics ──
async function loadTelemetryData() {
  const uptimeEl = document.getElementById('telem-uptime');
  const memEl = document.getElementById('telem-memory');
  const pingEl = document.getElementById('telem-sheets-ping');
  const dbEl = document.getElementById('telem-db-type');

  if (uptimeEl) uptimeEl.textContent = 'Loading...';

  try {
    const res = await authFetch('/api/admin/telemetry');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const t = data.telemetry;
    const hours = Math.floor(t.uptimeSeconds / 3600);
    const mins = Math.floor((t.uptimeSeconds % 3600) / 60);

    if (uptimeEl) uptimeEl.textContent = `${hours}h ${mins}m`;
    if (memEl) memEl.textContent = `${t.memoryUsage.heapUsedMB} MB`;
    if (pingEl) pingEl.textContent = t.sheetsApi.ok ? `${t.sheetsApi.latencyMs} ms` : '❌ Error';
    if (dbEl) dbEl.textContent = t.dbStatus.connected ? 'MongoDB' : 'Local JSON';
  } catch (err) {
    if (uptimeEl) uptimeEl.textContent = 'Error';
  }
}

// ── Admin: Audit Trail ──
async function loadAuditLogsUI() {
  const tbody = document.getElementById('adm-audit-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="padding: 16px; text-align: center;">Loading audit trail...</td></tr>';

  try {
    const res = await authFetch('/api/admin/audit-logs');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    let html = '';
    (data.logs || []).forEach(l => {
      html += `
        <tr style="border-bottom: 1px solid var(--border-light);">
          <td style="padding: 8px; font-size: 0.78rem; color: var(--text-muted);">${new Date(l.timestamp).toLocaleString()}</td>
          <td style="padding: 8px; font-weight: 600;">${l.username}</td>
          <td style="padding: 8px;"><code style="background: var(--bg-primary); padding: 2px 4px; border-radius: 4px; font-size: 0.75rem; color: var(--accent);">${l.action}</code></td>
          <td style="padding: 8px; font-size: 0.75rem; color: var(--text-secondary);">${l.ip || 'internal'}</td>
          <td style="padding: 8px; color: var(--text-secondary); font-size: 0.8rem;">${l.details || '—'}</td>
        </tr>
      `;
    });
    tbody.innerHTML = html || '<tr><td colspan="5" style="padding: 16px; text-align: center;">No audit logs recorded yet.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding: 16px; text-align: center; color: var(--red);">Error: ${err.message}</td></tr>`;
  }
}

// ── Internal Notes ──
function openNoteModal(targetId) {
  const modal = document.getElementById('note-modal');
  const inp = document.getElementById('note-target-id');
  const txt = document.getElementById('note-content-input');

  if (modal && inp && txt) {
    inp.value = targetId;
    txt.value = '';
    modal.style.display = 'flex';
  }
}

function closeNoteModal() {
  const modal = document.getElementById('note-modal');
  if (modal) modal.style.display = 'none';
}

async function submitInternalNote() {
  const targetId = document.getElementById('note-target-id')?.value;
  const note = document.getElementById('note-content-input')?.value;

  if (!targetId || !note || !note.trim()) {
    showToast('❌ Note content cannot be empty.');
    return;
  }

  try {
    const res = await authFetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId, note: note.trim() })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast('✅ Note added successfully.');
      closeNoteModal();
    } else {
      showToast(`❌ ${data.error || 'Failed to add note'}`);
    }
  } catch {
    showToast('❌ Network error adding note.');
  }
}

// ── Dynamic Branding Functions ──
let activeBrandingConfig = null;

async function loadPublicBranding() {
  try {
    const res = await fetch('/api/public/branding');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.branding) {
      activeBrandingConfig = data.branding;
      applyBrandingToUI(data.branding);
    }
  } catch (err) {
    console.warn('Failed to load public branding:', err);
  }
}

function applyBrandingToUI(branding) {
  if (!branding) return;

  // 1. Page Title
  if (branding.resortName) {
    document.title = `${branding.resortName} — Dashboard & Admin Portal`;
  }

  // 2. Header Brand Title
  const titleEl = document.getElementById('brand-title-el');
  if (titleEl && branding.resortName) {
    titleEl.textContent = branding.resortName;
  }

  // 3. Header Logo
  const logoEl = document.getElementById('brand-logo-el');
  if (logoEl && branding.logoUrl) {
    if (branding.logoUrl.startsWith('/') || branding.logoUrl.startsWith('http')) {
      logoEl.innerHTML = `<img src="${branding.logoUrl}" alt="Logo" style="height: 24px; vertical-align: middle;" onerror="this.outerHTML='📊'">`;
    } else {
      logoEl.textContent = branding.logoUrl;
    }
  }

  // 4. Login card logo, title, and tagline
  const loginLogoEl = document.getElementById('login-brand-logo');
  if (loginLogoEl && branding.logoUrl) {
    if (branding.logoUrl.startsWith('/') || branding.logoUrl.startsWith('http')) {
      loginLogoEl.innerHTML = `<img src="${branding.logoUrl}" alt="Logo" style="height: 48px; vertical-align: middle; margin-bottom: 8px;" onerror="this.outerHTML='🏝️'">`;
    } else {
      loginLogoEl.textContent = branding.logoUrl;
    }
  }
  const loginTitleEl = document.getElementById('login-brand-title');
  if (loginTitleEl && branding.resortName) {
    loginTitleEl.textContent = branding.resortName;
  }
  const loginTaglineEl = document.getElementById('login-brand-tagline');
  if (loginTaglineEl && branding.resortTagline) {
    loginTaglineEl.textContent = branding.resortTagline;
  }

  // 5. CSS variables for branding colors if custom
  if (branding.primaryColor) {
    document.documentElement.style.setProperty('--accent', branding.primaryColor);
  }
  if (branding.brandAccent) {
    document.documentElement.style.setProperty('--green', branding.brandAccent);
  }
}

// ── Initialization & Periodic Auth Checks ──────────────────────────────────
loadPublicBranding();
checkAuth();
setInterval(() => {
  if (currentUser) loadData(true);
}, 120_000);

// ── Admin Dashboard Booking Edit Modal Functions ──

let currentEditingBookingKey = null;
let currentEditingRowIndex = null;

function openEditBookingModalByIndex(rowIndex, code) {
  let booking = (activeTab === 'bookings' ? currentBookings : allBookings).find(b => b.rowIndex === rowIndex);
  if (!booking) {
    booking = (allBookings || []).find(b => b.rowIndex === rowIndex) || (currentBookings || []).find(b => b.rowIndex === rowIndex);
  }

  const headers = bookingsHeaders || [];
  const rowData = booking ? (booking.row || []) : [];

  openEditBookingModal(rowData, headers, rowIndex, booking ? booking.overrideMeta : null, booking ? booking.isOverridden : false, booking);
}

function openEditBookingModal(rowData, headers, rowIndex, overrideMeta, isOverridden, booking) {
  const modal = document.getElementById('edit-booking-modal');
  if (!modal) return;

  const getColVal = (name) => {
    if (!headers || !headers.length) return '';
    const idx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === name.toUpperCase());
    return idx !== -1 ? (rowData[idx] || '') : '';
  };

  const getFieldVal = (name, aliases = [], fallbackIndex = -1) => {
    let val = getColVal(name);
    if (val !== undefined && val !== null && String(val).trim() !== '') return String(val).trim();
    for (const a of aliases) {
      val = getColVal(a);
      if (val !== undefined && val !== null && String(val).trim() !== '') return String(val).trim();
    }
    if (fallbackIndex !== -1 && rowData[fallbackIndex] !== undefined && rowData[fallbackIndex] !== null && String(rowData[fallbackIndex]).trim() !== '') {
      return String(rowData[fallbackIndex]).trim();
    }
    return '';
  };

  const key = `ROW_${rowIndex}`;
  currentEditingBookingKey = key;
  currentEditingRowIndex = rowIndex;

  document.getElementById('edit-booking-key').value = key;
  document.getElementById('edit-booking-row-index').value = rowIndex;

  // Basic Details
  document.getElementById('edit-field-name').value = getFieldVal('NAME', ['CUSTOMER NAME', 'GUEST NAME'], 3);
  document.getElementById('edit-field-code').value = getFieldVal('CODE', ['BOOKING CODE'], 1);
  document.getElementById('edit-field-pic').value = getFieldVal('PIC', ['PERSON IN CHARGE'], 2);

  // Dates & Duration
  document.getElementById('edit-field-checkin').value = getFieldVal('CHECK IN', ['CHECK-IN', 'CHECKIN'], 7);
  document.getElementById('edit-field-checkout').value = getFieldVal('CHECK OUT', ['CHECK-OUT', 'CHECKOUT'], 8);
  document.getElementById('edit-field-staying-days').value = getFieldVal('STAYING DAYS', ['DAYS', 'STAY DURATION', 'ROOM DETAILS'], 9);

  // Activities (supports SNORKELLING with double-L, SNORKELING, SNORKEL, or col 4)
  document.getElementById('edit-field-snorkeling').value = getFieldVal('SNORKELLING', ['SNORKELING', 'SNORKEL'], 4);
  document.getElementById('edit-field-diving').value = getFieldVal('DIVING', ['DIVE'], 5);
  document.getElementById('edit-field-course').value = getFieldVal('COURSE', ['COURSES'], 6);

  // Room Information
  document.getElementById('edit-field-room').value = getFieldVal('ROOM', ['ROOM ASSIGNED', 'ROOM_ASSIGNED'], 25);
  document.getElementById('edit-field-roomtype').value = getFieldVal('ROOM TYPE', ['ROOM_TYPE', 'ROOMTYPE'], 10);

  // Pax calculation (Activity / Headcount Pax vs Room Bed Pax)
  let actPax = 0;
  try {
    actPax = getRowActivityPaxClient(rowData);
  } catch (e) {}
  const guestPaxVal = (actPax > 0) ? String(actPax) : (booking?.pax ? String(booking.pax) : '');
  const roomPaxVal = getFieldVal('ROOM_PAX', ['ROOM PAX'], 26);

  document.getElementById('edit-field-guestpax').value = guestPaxVal || roomPaxVal || '';
  document.getElementById('edit-field-roompax').value = roomPaxVal || guestPaxVal || '';

  // Financials
  document.getElementById('edit-field-total').value = getFieldVal('TOTAL AMOUNT', ['TOTAL'], 18);
  document.getElementById('edit-field-deposit').value = getFieldVal('DEPOSIT', [], 19);
  document.getElementById('edit-field-balance').value = getFieldVal('BALANCE', [], 20);
  document.getElementById('edit-field-status').value = getFieldVal('STATUS', [], 21);

  // Special Request & Remarks
  document.getElementById('edit-field-special-request').value = getFieldVal('SPECIAL REQUEST', ['SPECIAL_REQUEST', 'SPECIAL REQUESTS', 'REQUEST'], 13);
  document.getElementById('edit-field-remark').value = getFieldVal('REMARK', ['REMARKS'], 22);

  const banner = document.getElementById('edit-override-banner');
  if (banner) {
    banner.style.display = isOverridden ? 'flex' : 'none';
  }

  modal.style.display = 'flex';
}

function closeEditBookingModal() {
  const modal = document.getElementById('edit-booking-modal');
  if (modal) modal.style.display = 'none';
}

async function saveBookingEdit(event) {
  if (event) event.preventDefault();

  const key = document.getElementById('edit-booking-key').value;
  const rowIndex = parseInt(document.getElementById('edit-booking-row-index').value, 10);
  const saveBtn = document.getElementById('edit-booking-save-btn');

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving Overrides...';
  }

  const fields = {
    'NAME': document.getElementById('edit-field-name').value.trim(),
    'CODE': document.getElementById('edit-field-code').value.trim(),
    'PIC': document.getElementById('edit-field-pic').value.trim(),
    'CHECK IN': document.getElementById('edit-field-checkin').value.trim(),
    'CHECK OUT': document.getElementById('edit-field-checkout').value.trim(),
    'STAYING DAYS': document.getElementById('edit-field-staying-days').value.trim(),
    'SNORKELING': document.getElementById('edit-field-snorkeling').value.trim(),
    'SNORKELLING': document.getElementById('edit-field-snorkeling').value.trim(),
    'DIVING': document.getElementById('edit-field-diving').value.trim(),
    'COURSE': document.getElementById('edit-field-course').value.trim(),
    'ROOM': document.getElementById('edit-field-room').value.trim(),
    'ROOM TYPE': document.getElementById('edit-field-roomtype').value.trim(),
    'ROOM_TYPE': document.getElementById('edit-field-roomtype').value.trim(),
    'GUEST_PAX': document.getElementById('edit-field-guestpax').value.trim(),
    'ROOM_PAX': document.getElementById('edit-field-roompax').value.trim(),
    'TOTAL AMOUNT': document.getElementById('edit-field-total').value.trim(),
    'DEPOSIT': document.getElementById('edit-field-deposit').value.trim(),
    'BALANCE': document.getElementById('edit-field-balance').value.trim(),
    'STATUS': document.getElementById('edit-field-status').value.trim(),
    'SPECIAL REQUEST': document.getElementById('edit-field-special-request').value.trim(),
    'REMARK': document.getElementById('edit-field-remark').value.trim()
  };

  try {
    const res = await authFetch('/api/admin/bookings/override', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingKey: key, rowIndex, fields })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.removeItem(DASHBOARD_CACHE_KEY); // Invalidate client cache
      closeEditBookingModal();
      showToast('✅ Booking details overridden on Dashboard successfully!');
      await loadData(true);
    } else {
      showToast('❌ Error: ' + (data.error || 'Failed to save override.'));
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      console.error(err);
      showToast('❌ Network error saving booking override.');
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Dashboard Overrides';
    }
  }
}

async function revertBookingEdit() {
  const key = document.getElementById('edit-booking-key').value;
  const rowIndexVal = document.getElementById('edit-booking-row-index').value;
  const rowIndex = parseInt(rowIndexVal, 10);
  if (!key && isNaN(rowIndex)) return;

  if (!confirm('Are you sure you want to revert this booking back to original Google Sheet values?')) {
    return;
  }

  try {
    const res = await authFetch('/api/admin/bookings/override', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingKey: key, rowIndex: !isNaN(rowIndex) ? rowIndex : undefined })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.removeItem(DASHBOARD_CACHE_KEY);
      closeEditBookingModal();
      showToast('✅ Booking reverted to original sheet values!');
      await loadData(true);
    } else {
      showToast('❌ Error: ' + (data.error || 'Failed to revert override.'));
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      console.error(err);
      showToast('❌ Network error reverting override.');
    }
  }
}

// ── Copy Helper & Booking Details Copy Functions ──

function copyTextToClipboard(text, successMsg) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg || '📋 Copied to clipboard!');
    }).catch(() => {
      fallbackCopyTextToClipboard(text, successMsg);
    });
  } else {
    fallbackCopyTextToClipboard(text, successMsg);
  }
}

function fallbackCopyTextToClipboard(text, successMsg) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  textArea.style.top = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
    showToast(successMsg || '📋 Copied to clipboard!');
  } catch (err) {
    showToast('❌ Unable to copy text.');
  }
  document.body.removeChild(textArea);
}

function copyBookingDetails(rowIndex, event) {
  if (event) event.stopPropagation();

  let booking = (activeTab === 'bookings' ? currentBookings : allBookings).find(b => b.rowIndex === rowIndex);
  if (!booking) {
    booking = (allBookings || []).find(b => b.rowIndex === rowIndex) || (currentBookings || []).find(b => b.rowIndex === rowIndex);
  }

  const headers = bookingsHeaders || [];
  const rowData = booking ? (booking.row || []) : [];

  const getColVal = (name) => {
    if (!headers || !headers.length) return '';
    const idx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === name.toUpperCase());
    return idx !== -1 ? (rowData[idx] || '') : '';
  };

  const code = getColVal('CODE') || rowData[1] || '—';
  const name = getColVal('NAME') || rowData[3] || '—';
  const checkIn = getColVal('CHECK IN') || getColVal('CHECK-IN') || rowData[7] || '—';
  const checkOut = getColVal('CHECK OUT') || getColVal('CHECK-OUT') || rowData[8] || '—';
  const room = getColVal('ROOM') || getColVal('ROOM ASSIGNED') || '—';
  const pax = getColVal('ROOM_PAX') || booking?.pax || '1';
  const snork = getColVal('SNORKELING') || getColVal('SNORKELLING') || rowData[4] || '';
  const dive = getColVal('DIVING') || rowData[5] || '';
  const course = getColVal('COURSE') || rowData[6] || '';
  const remark = getColVal('REMARK') || getColVal('REMARKS') || '';

  let summary = `📋 BOOKING DETAILS\n` +
    `• Code: ${code}\n` +
    `• Guest Name: ${name}\n` +
    `• Stay Dates: ${checkIn} → ${checkOut}\n` +
    `• Guests (Pax): ${pax} Pax\n` +
    (room && room !== '—' ? `• Room: ${room}\n` : '') +
    (snork ? `• Snorkeling: ${snork}\n` : '') +
    (dive ? `• Diving: ${dive}\n` : '') +
    (course ? `• Course: ${course}\n` : '') +
    (remark ? `• Remark: ${remark}\n` : '');

  copyTextToClipboard(summary, `📋 Booking details for ${name} copied!`);
}

async function revertBookingOverrideDirect(key, rowIndex, event) {
  if (event) event.stopPropagation();
  const overrideKey = key || `ROW_${rowIndex}`;
  if (!confirm('Are you sure you want to revert this booking back to original Google Sheet values?')) {
    return;
  }

  try {
    const res = await authFetch('/api/admin/bookings/override', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingKey: overrideKey, rowIndex })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.removeItem(DASHBOARD_CACHE_KEY);
      showToast('✅ Booking reverted to original sheet values!');
      await loadData(true);
    } else {
      showToast('❌ Error: ' + (data.error || 'Failed to revert override.'));
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      console.error(err);
      showToast('❌ Network error reverting override.');
    }
  }
}

// ── Admin: Boat Transfer Report Generator ──

function initBoatReportUI() {
  const startInput = document.getElementById('boat-start-date');
  const endInput = document.getElementById('boat-end-date');

  if (startInput && !startInput.value) {
    const todayStr = new Date().toISOString().split('T')[0];
    startInput.value = todayStr;
    if (endInput && !endInput.value) {
      endInput.value = todayStr;
    }
    fetchBoatReportPreview();
  }
}

function applyBoatReportPreset(preset) {
  const startInput = document.getElementById('boat-start-date');
  const endInput = document.getElementById('boat-end-date');
  if (!startInput || !endInput) return;

  const today = new Date();
  const formatDate = (d) => d.toISOString().split('T')[0];

  if (preset === 'today') {
    startInput.value = formatDate(today);
    endInput.value = formatDate(today);
  } else if (preset === 'tomorrow') {
    const tom = new Date(today);
    tom.setDate(today.getDate() + 1);
    startInput.value = formatDate(tom);
    endInput.value = formatDate(tom);
  } else if (preset === 'next3') {
    const end = new Date(today);
    end.setDate(today.getDate() + 2);
    startInput.value = formatDate(today);
    endInput.value = formatDate(end);
  } else if (preset === 'next7') {
    const end = new Date(today);
    end.setDate(today.getDate() + 6);
    startInput.value = formatDate(today);
    endInput.value = formatDate(end);
  }

  fetchBoatReportPreview();
}

function formatPaxObj(p) {
  if (!p) return '0';
  const parts = [];
  if (p.a > 0) parts.push(`${p.a}A`);
  if (p.c > 0) parts.push(`${p.c}C`);
  if (p.b > 0) parts.push(`${p.b}B`);
  return parts.length > 0 ? parts.join(' ') : '0';
}

async function fetchBoatReportPreview() {
  const container = document.getElementById('boat-report-preview-container');
  const startInput = document.getElementById('boat-start-date');
  const endInput = document.getElementById('boat-end-date');
  const filterInput = document.getElementById('boat-filter-type');

  if (!container) return;

  const startDate = startInput?.value || new Date().toISOString().split('T')[0];
  const endDate = endInput?.value || startDate;
  const filterType = filterInput?.value || 'both';

  container.innerHTML = `
    <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
      <div class="spinner" style="margin: 0 auto 12px;"></div>
      Generating boat transfer report preview for ${startDate} to ${endDate}...
    </div>
  `;

  try {
    const res = await authFetch('/api/admin/reports/boat-transfer/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, filterType })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to generate report preview');
    }

    const { report, formattedMessages } = data;
    const { summary, days } = report;

    // Build Summary Cards HTML
    let html = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px;">
        <div style="background: var(--bg-primary); border: 1px solid var(--border); padding: 14px; border-radius: var(--radius-sm);">
          <span style="font-size: 0.75rem; color: var(--text-secondary);">Total Check-Ins</span>
          <div style="font-size: 1.4rem; font-weight: 700; color: var(--green); margin-top: 2px;">${summary.totalCheckIns}</div>
        </div>
        <div style="background: var(--bg-primary); border: 1px solid var(--border); padding: 14px; border-radius: var(--radius-sm);">
          <span style="font-size: 0.75rem; color: var(--text-secondary);">Total Check-Outs</span>
          <div style="font-size: 1.4rem; font-weight: 700; color: var(--accent); margin-top: 2px;">${summary.totalCheckOuts}</div>
        </div>
        <div style="background: var(--bg-primary); border: 1px solid var(--border); padding: 14px; border-radius: var(--radius-sm);">
          <span style="font-size: 0.75rem; color: var(--text-secondary);">Total Passengers</span>
          <div style="font-size: 1.4rem; font-weight: 700; color: var(--yellow); margin-top: 2px;">${summary.totalGuests} Guests</div>
        </div>
        <div style="background: var(--bg-primary); border: 1px solid var(--border); padding: 14px; border-radius: var(--radius-sm);">
          <span style="font-size: 0.75rem; color: var(--text-secondary);">Pax Breakdown</span>
          <div style="font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin-top: 4px;">
            ${formatPaxObj(summary.totalPax)}
          </div>
        </div>
      </div>
    `;

    // Render Each Day Manifest & Telegram Preview
    days.forEach((day, index) => {
      const msgItem = formattedMessages[index] || {};
      
      html += `
        <div style="background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 24px; overflow: hidden;">
          <div style="padding: 12px 18px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
            <strong style="font-size: 0.95rem; color: var(--text-primary);">📅 ${escapeHtml(day.label)} (${day.dateStr})</strong>
            <span class="badge" style="background: var(--accent-glow); color: var(--accent);">
              In: ${day.checkIns.length} | Out: ${day.checkOuts.length}
            </span>
          </div>

          <div style="padding: 18px;">
            <!-- Check-Outs Section -->
            ${(filterType === 'both' || filterType === 'checkout') ? `
              <div style="margin-bottom: 18px;">
                <h5 style="font-size: 0.88rem; color: var(--accent); margin-bottom: 8px; font-weight: 600;">
                  📤 Check-Out 08:30am (${day.checkOuts.length} bookings)
                </h5>
                ${day.checkOuts.length === 0 ? `
                  <div style="font-size: 0.8rem; color: var(--text-muted); padding: 8px 12px; background: var(--bg-card); border-radius: 4px;">No check-outs for this date.</div>
                ` : `
                  <table class="booking-table" style="width: 100%; font-size: 0.82rem;">
                    <thead>
                      <tr style="background: var(--bg-card); text-align: left;">
                        <th style="padding: 8px 10px;">Booking Code</th>
                        <th style="padding: 8px 10px;">Guest Name</th>
                        <th style="padding: 8px 10px;">Room</th>
                        <th style="padding: 8px 10px;">Pax</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${day.checkOuts.map(c => `
                        <tr>
                          <td style="padding: 8px 10px;"><code>${escapeHtml(c.code || '—')}</code></td>
                          <td style="padding: 8px 10px;"><strong>${escapeHtml(c.name || '—')}</strong></td>
                          <td style="padding: 8px 10px;">${escapeHtml(c.room || '—')}</td>
                          <td style="padding: 8px 10px;">${formatPaxObj(c.pax)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                `}
              </div>
            ` : ''}

            <!-- Check-Ins Section -->
            ${(filterType === 'both' || filterType === 'checkin') ? `
              <div style="margin-bottom: 18px;">
                <h5 style="font-size: 0.88rem; color: var(--green); margin-bottom: 8px; font-weight: 600;">
                  📥 Check-In 10:30am (${day.checkIns.length} bookings)
                </h5>
                ${day.checkIns.length === 0 ? `
                  <div style="font-size: 0.8rem; color: var(--text-muted); padding: 8px 12px; background: var(--bg-card); border-radius: 4px;">No check-ins for this date.</div>
                ` : `
                  <table class="booking-table" style="width: 100%; font-size: 0.82rem;">
                    <thead>
                      <tr style="background: var(--bg-card); text-align: left;">
                        <th style="padding: 8px 10px;">Booking Code</th>
                        <th style="padding: 8px 10px;">Guest Name</th>
                        <th style="padding: 8px 10px;">Room</th>
                        <th style="padding: 8px 10px;">Pax</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${day.checkIns.map(c => `
                        <tr>
                          <td style="padding: 8px 10px;"><code>${escapeHtml(c.code || '—')}</code></td>
                          <td style="padding: 8px 10px;"><strong>${escapeHtml(c.name || '—')}</strong></td>
                          <td style="padding: 8px 10px;">${escapeHtml(c.room || '—')}</td>
                          <td style="padding: 8px 10px;">${formatPaxObj(c.pax)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                `}
              </div>
            ` : ''}

            <!-- Telegram Message Preview Box -->
            <div style="margin-top: 14px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-secondary);">📱 Telegram Channel Output Preview</span>
                <button type="button" class="action-btn" onclick="copyTextToClipboard(\`${escapeHtml(msgItem.messageText || '')}\`, 'Copied Telegram message text!')" style="padding: 2px 8px; font-size: 0.72rem;">📋 Copy Text</button>
              </div>
              <pre style="background: #0d1117; color: #e6edf3; padding: 12px; border-radius: 6px; border: 1px solid var(--border); font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; white-space: pre-wrap; word-break: break-word; margin: 0;">${escapeHtml(msgItem.messageText || '')}</pre>
            </div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  } catch (err) {
    console.error('❌ Error fetching boat report preview:', err);
    container.innerHTML = `
      <div style="background: var(--red-bg); color: var(--red); border: 1px solid rgba(248,81,73,0.3); padding: 16px; border-radius: var(--radius-sm); font-size: 0.85rem;">
        ❌ Failed to load boat transfer report preview: ${escapeHtml(err.message)}
      </div>
    `;
  }
}

async function sendBoatReportToTelegram() {
  const startInput = document.getElementById('boat-start-date');
  const endInput = document.getElementById('boat-end-date');
  const filterInput = document.getElementById('boat-filter-type');
  const sendBtn = document.getElementById('send-boat-tg-btn');

  const startDate = startInput?.value || new Date().toISOString().split('T')[0];
  const endDate = endInput?.value || startDate;
  const filterType = filterInput?.value || 'both';

  const rangeLabel = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
  if (!confirm(`Are you sure you want to send separate Boat Transfer Report message(s) for ${rangeLabel} to the Telegram Boat Transfer Channel?`)) {
    return;
  }

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ Sending...';
  }

  try {
    const res = await authFetch('/api/admin/reports/boat-transfer/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, filterType })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to send boat report to Telegram.');
    }

    showToast(`✅ Boat transfer report sent to Telegram! (${data.sentCount} message(s) delivered)`);
    alert(`✅ Success!\nBoat transfer report for ${rangeLabel} was posted to the Telegram boat transfer channel (${data.sentCount} message(s) sent).`);
  } catch (err) {
    console.error('❌ Error sending boat report to Telegram:', err);
    showToast(`❌ Error sending report: ${err.message}`);
    alert(`❌ Failed to send boat report to Telegram: ${err.message}`);
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = '📡 Send to TG';
    }
  }
}

