const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const { loadBotConfig } = require('./snapshot');

const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;

/**
 * Fetch wrapper with timeout and retry.
 * @param {string} url
 * @param {object} options - fetch options
 * @param {number} timeoutMs - per-attempt timeout
 * @param {number} retries - number of retries on failure
 * @returns {Response|null} Response object or null if all attempts fail
 */
async function fetchWithRetry(url, options, timeoutMs = FETCH_TIMEOUT_MS, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } catch (err) {
      if (attempt < retries) {
        const delay = (attempt + 1) * 1000;
        console.warn(`   ⚠️  Fetch attempt ${attempt + 1}/${retries + 1} failed: ${err.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`   ❌  Fetch failed after ${retries + 1} attempts: ${err.message}`);
        return null;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Helper to check if Telegram notifications should be disabled/suppressed.
 * TG notifications are disabled if:
 * 1. DISABLE_TELEGRAM=true is explicitly set, OR
 * 2. NODE_ENV === 'development' (unless ENABLE_TELEGRAM_IN_DEV=true is set).
 */
function isTelegramDisabled() {
  if (process.env.DISABLE_TELEGRAM === 'true') return true;
  if (process.env.ENABLE_TELEGRAM_IN_DEV === 'true') return false;
  return process.env.NODE_ENV === 'development';
}

/**
 * Sends a Telegram message.
 * @param {string} text - The message text (supports Telegram HTML formatting)
 * @param {object} replyMarkup - Optional Telegram reply_markup (e.g. inline keyboard)
 * @param {string} targetChatId - Target chat ID
 * @returns {number|null} The message_id of the sent message, or null on failure
 */
async function sendMessage(text, replyMarkup = null, targetChatId = CHAT_ID, disableNotification = false) {
  if (isTelegramDisabled()) {
    const target = targetChatId || CHAT_ID;
    const preview = (text || '').replace(/\n/g, ' ').substring(0, 80);
    console.log(`   ℹ️  [DEV MODE] Telegram message suppressed (${target}): ${preview}...`);
    return Math.floor(Date.now() / 1000);
  }

  if (!BOT_TOKEN || !targetChatId) {
    console.warn('   ⚠️  Telegram not configured. Skipping notification.');
    return null;
  }

  const target = targetChatId || CHAT_ID;
  if (!targetChatId) {
    console.warn(`   ⚠️  sendMessage called without targetChatId. Falling back to TELEGRAM_CHAT_ID.`);
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const requestBody = {
    chat_id: targetChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: disableNotification,
  };

  if (replyMarkup) {
    requestBody.reply_markup = replyMarkup;
  }

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response) {
    console.error('   ❌  Failed to send Telegram message after all retries.');
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`   ❌  Telegram API error: ${response.statusText} (${errorText})`);
    return null;
  }

  const data = await response.json();
  return data?.result?.message_id || null;
}

/**
 * Deletes a Telegram message by chat_id and message_id.
 * @param {string} chatId
 * @param {number} messageId
 */
async function deleteMessage(chatId, messageId) {
  if (isTelegramDisabled()) {
    console.log(`   ℹ️  [DEV MODE] Telegram deleteMessage suppressed (${chatId}, msg ${messageId})`);
    return;
  }

  if (!BOT_TOKEN || !chatId || !messageId) return;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    if (!response.ok) {
      console.warn(`   ⚠️  Failed to delete Telegram message ${messageId}: ${response.statusText}`);
    }
  } catch (err) {
    console.warn(`   ⚠️  Failed to delete Telegram message ${messageId}: ${err.message}`);
  }
}

const EXCLUDED_HEADERS = [
  'ROW_COLOR',
  'TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS',
  'ROOM TYPE', 'STAYING DAYS', 'SHARING', 'ROOM SHARING',
  'PHONE', 'PHONE NO', 'PHONE NO.', 'PHONE NUMBER', 'PHONE NUMBERS',
  'CONTACT', 'CONTACT NO', 'CONTACT NO.', 'CONTACT NUMBER', 'CONTACT NUMBERS',
  'MOBILE', 'MOBILE NO', 'MOBILE NO.', 'MOBILE NUMBER',
  'TEL', 'TEL NO', 'TEL NO.', 'TELEPHONE',
  'HP', 'H/P', 'HP NO', 'H/P NO', 'HANDPHONE',
  'WHATSAPP', 'WHATSAPP NO', 'NO TEL', 'NO TELEFON',
  'CUSTOMER NUMBER', 'CUSTOMER PHONE', 'GUEST PHONE', 'GUEST CONTACT'
];

function isExcludedTelegramHeader(header) {
  if (!header || typeof header !== 'string') return false;
  const h = header.toUpperCase().trim();
  if (EXCLUDED_HEADERS.includes(h)) return true;
  if (/\b(CONTACT|PHONE|MOBILE|HANDPHONE|WHATSAPP|TELEPHONE)\b/i.test(h)) return true;
  if (/^(HP|H\/P|TEL)(\s*(NO|NUM|NUMBER|\.))?$/i.test(h)) return true;
  return false;
}

/**
 * Format a row's data as a compact HTML list using headers.
 */
function formatRow(row, headers) {
  return headers
    .map((header, i) => {
      const val = (row[i] || '').toString().trim();
      if (!val) return null;
      const headerUpper = header.toUpperCase().trim();
      if (isExcludedTelegramHeader(headerUpper)) return null;
      return `  • <b>${escapeHtml(header)}:</b> ${escapeHtml(val)}`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Format a modified row's data, appending a 🟡 marker to changed columns.
 */
function formatModifiedRow(row, headers, changes) {
  const changedColumns = new Set(changes.map(c => c.column));
  return headers
    .map((header, i) => {
      const val = (row[i] || '').toString().trim();
      if (!val) return null;
      const headerUpper = header.toUpperCase().trim();
      if (isExcludedTelegramHeader(headerUpper)) return null;
      const isChanged = changedColumns.has(header);
      const marker = isChanged ? ' 🟡 (changed)' : '';
      return `  • <b>${escapeHtml(header)}${marker}:</b> ${escapeHtml(val)}`;
    })
    .filter(Boolean)
    .join('\n');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build and send a Telegram alert summarizing detected changes.
 */
async function sendTelegramAlert({ newRows = [], modifiedRows = [], error = null, checkedAt, offlineInfo, eventId, chatId }) {
  const now = checkedAt || new Date();
  const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
  const timestamp = now.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' });

  const targetChatId = chatId || CHAT_ID;
  if (!chatId) {
    console.warn(`   ⚠️  No chatId provided to sendTelegramAlert. Falling back to TELEGRAM_CHAT_ID (${CHAT_ID}).`);
  }
  console.log(`   📨 sendTelegramAlert → target chat: ${targetChatId}`);

  // ── Error notification ──────────────────────────────────────────────────
  if (error) {
    await sendMessage(
      `🚨 <b>Sheets Bot Error</b>\n` +
      `🕐 ${timestamp}\n\n` +
      `❌ ${escapeHtml(error)}`,
      null,
      targetChatId
    );
    return;
  }

  const parts = [];

  let offlineHeader = '';
  if (offlineInfo && offlineInfo.wasOffline) {
    offlineHeader = `🔌 <b>Bot Back Online</b> (Offline for: <code>${escapeHtml(offlineInfo.duration)}</code>)\n`;
  }

  const config = await loadBotConfig();
  const resortName = config?.resortName || 'TCBR';

  // Filter modified rows to exclude contact / phone / payment changes
  const validModifiedRows = [];
  for (const entry of (modifiedRows || [])) {
    const filteredChanges = (entry.changes || []).filter(c => !isExcludedTelegramHeader(c.column.toUpperCase().trim()));
    if (filteredChanges.length > 0) {
      validModifiedRows.push({ ...entry, changes: filteredChanges });
    }
  }

  // If no new rows and no actionable modified rows remain after exclusion, suppress Telegram notification
  if (newRows.length === 0 && validModifiedRows.length === 0) {
    console.log('   ℹ️  sendTelegramAlert: no actionable changes after column exclusion, skipping notification.');
    return null;
  }

  parts.push(
    (offlineHeader ? offlineHeader + '\n' : '') +
    `📊 <b>${escapeHtml(resortName)} — ${escapeHtml(monthName)}</b>\n` +
    `🕐 Checked at: ${timestamp}\n`
  );

  // ── New rows ─────────────────────────────────────────────────────────────
  if (newRows.length > 0) {
    parts.push(`\n🟢 <b>${newRows.length} New Row(s) This Month:</b>`);
    for (const entry of newRows.slice(0, 10)) { // cap at 10 to avoid huge messages
      parts.push(
        `\n━━━━━━━━━━━━━━━\n` +
        formatRow(entry.row, entry.headers)
      );
    }
    if (newRows.length > 10) {
      parts.push(`\n  ... and ${newRows.length - 10} more new rows.`);
    }
  }

  // ── Modified rows ─────────────────────────────────────────────────────────
  if (validModifiedRows.length > 0) {
    parts.push(`\n\n🟡 <b>${validModifiedRows.length} Modified Row(s) This Month:</b>`);
    for (const entry of validModifiedRows.slice(0, 10)) {
      const fullRowText = formatModifiedRow(entry.row, entry.headers, entry.changes);
      
      const changesText = entry.changes
        .map(c =>
          `  • <b>${escapeHtml(c.column)}:</b>\n` +
          `    ❌ Was: ${escapeHtml(c.before) || '(empty)'}\n` +
          `    ✅ Now: ${escapeHtml(c.after)  || '(empty)'}`
        )
        .join('\n');

      const changesSection = changesText
        ? `\n\n<b>⚡ What Changed:</b>\n${changesText}`
        : '';

      parts.push(
        `\n━━━━━━━━━━━━━━━\n` +
        `<b>📋 Full Row Data:</b>\n${fullRowText}${changesSection}`
      );
    }
    if (validModifiedRows.length > 10) {
      parts.push(`\n  ... and ${validModifiedRows.length - 10} more modified rows.`);
    }
  }

  const fullMessage = parts.join('');

  // Create acknowledgement buttons for Telegram changes (Reception and Dive Center)
  const replyMarkup = eventId ? {
    inline_keyboard: [
      [
        {
          text: '🛎 Reception',
          callback_data: `ack_rec:${eventId}`
        },
        {
          text: '🤿 Dive Center',
          callback_data: `ack_div:${eventId}`
        }
      ]
    ]
  } : null;

  // Telegram has a 4096 char limit per message — split if needed
  const LIMIT = 4000;
  if (fullMessage.length <= LIMIT) {
    await sendMessage(fullMessage, replyMarkup, targetChatId);
  } else {
    // Send in chunks
    let chunk = '';
    const lines = fullMessage.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((chunk + line + '\n').length > LIMIT) {
        await sendMessage(chunk, null, targetChatId);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk.trim()) {
      await sendMessage(chunk, replyMarkup, targetChatId);
    }
  }
}

/**
 * Edits a Telegram message text by chat_id and message_id.
 * @param {string} chatId
 * @param {number} messageId
 * @param {string} text
 * @returns {boolean} True if successful, false otherwise
 */
async function editMessageText(chatId, messageId, text, replyMarkup = null) {
  if (isTelegramDisabled()) {
    const preview = (text || '').replace(/\n/g, ' ').substring(0, 80);
    console.log(`   ℹ️  [DEV MODE] Telegram editMessageText suppressed (${chatId}, msg ${messageId}): ${preview}...`);
    return true;
  }

  if (!BOT_TOKEN || !chatId || !messageId) return false;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
  const requestBody = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (replyMarkup) {
    requestBody.reply_markup = replyMarkup;
  }

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response) return false;

  if (!response.ok) {
    const errorText = await response.text();
    console.warn(`   ⚠️  Telegram editMessageText API error: ${response.statusText} (${errorText})`);
    return false;
  }

  const data = await response.json();
  return data?.ok || false;
}

module.exports = { sendTelegramAlert, sendMessage, deleteMessage, editMessageText, isTelegramDisabled };
