const { acknowledgeEvent, loadHistory, loadSnapshot, getDbStatus, appendHistory, appendVerification, getVerifications, loadUsers, saveUsers, appendAuditLog } = require('./snapshot');
const { fetchAndEnrichSheetData, fetchSheetData } = require('./sheets');
const { sendWeeklyReport, affectsReportWindow, getChangedDates } = require('./weeklyReport');
const { isQuietHours } = require('./quietHours');
const REPORT_CHAT_ID = process.env.TELEGRAM_REPORT_CHAT_ID;

let lastUpdateId = 0;
let runCheckCallback = null;
const processedUpdateIds = new Set();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const { isTelegramDisabled } = require('./telegram');

/**
 * Sends a message back to a specific Telegram chat.
 */
async function sendDirectMessage(chatId, text) {
  if (isTelegramDisabled()) {
    const preview = (text || '').replace(/\n/g, ' ').substring(0, 80);
    console.log(`   ℹ️  [DEV MODE] Telegram direct reply suppressed (${chatId}): ${preview}...`);
    return;
  }

  if (!BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`   ❌ Failed to send direct Telegram reply: ${res.statusText} (${errText})`);
    }
  } catch (err) {
    console.error('   ❌ Failed to send direct Telegram reply:', err.message);
  }
}

/**
 * Parses and routes Telegram updates (bot commands & button clicks).
 */
async function handleTelegramUpdate(update) {
  if (!BOT_TOKEN) return;

  // Deduplicate updates by update_id
  if (update.update_id) {
    if (processedUpdateIds.has(update.update_id)) {
      console.log(`ℹ️ Telegram update ${update.update_id} already processed. Skipping.`);
      return;
    }
    processedUpdateIds.add(update.update_id);
    // Keep set size bounded
    if (processedUpdateIds.size > 1000) {
      const firstVal = processedUpdateIds.values().next().value;
      processedUpdateIds.delete(firstVal);
    }
  }

  // ── 1. Handle Bot Commands ────────────────────────────────────────────────
  const message = update.message || update.channel_post;
  if (message && message.text) {
    const text = message.text.trim();
    const chatId = message.chat.id;

    if (text.startsWith('/')) {
      const command = text.split(' ')[0].split('@')[0].toLowerCase();
      console.log(`💬 Received Telegram command: "${command}" from chat ${chatId}`);

      if (command === '/help') {
        const helpMsg = `🤖 <b>Sheets Bot Help Menu</b>\n\n` +
          `• <b>/status</b> - Get database, uptime, and check status.\n` +
          `• <b>/summary</b> - List current month bookings.\n` +
          `• <b>/report</b> - Generate 10-day customer report (check-ins & check-outs).\n` +
          `• <b>/housekeeping</b> (or <b>/hk</b>) - Generate housekeeping room list (today / tomorrow).\n` +
          `• <b>/transfercheck</b> - Check for booking changes and update report.\n` +
          `• <b>/check</b> - Trigger a manual sheet check right now.\n` +
          `• <b>/remind</b> - Trigger manual check and send 30-day reminders.\n` +
          `• <b>/pending</b> - List registration requests pending approval.\n` +
          `• <b>/approve &lt;username&gt;</b> - Approve a pending user account.\n` +
          `• <b>/help</b> - View this menu.`;
        await sendDirectMessage(chatId, helpMsg);
      }

      else if (command === '/pending') {
        const users = await loadUsers();
        const pendingUsers = users.filter(u => u.approved === false);

        if (pendingUsers.length === 0) {
          await sendDirectMessage(chatId, 'ℹ️ <b>No registration requests pending approval.</b>');
        } else {
          let pendingMsg = `⏳ <b>Pending Account Approvals (${pendingUsers.length})</b>\n`;
          pendingUsers.forEach((u, i) => {
            pendingMsg += `\n${i + 1}. <b>${u.displayName || u.username}</b>\n` +
              `   • Username: <code>${u.username}</code>\n` +
              `   • Email: ${u.email || u.username}\n` +
              `   • Approve command: <code>/approve ${u.username}</code>`;
          });
          await sendDirectMessage(chatId, pendingMsg);
        }
      }

      else if (command === '/approve') {
        const parts = text.split(' ');
        const targetInput = parts[1] ? parts[1].trim().toLowerCase() : null;

        if (!targetInput) {
          await sendDirectMessage(chatId, '⚠️ <b>Usage:</b> <code>/approve &lt;username_or_email&gt;</code>');
        } else {
          const users = await loadUsers();
          const user = users.find(u => u.username.toLowerCase() === targetInput || (u.email && u.email.toLowerCase() === targetInput));

          if (!user) {
            await sendDirectMessage(chatId, `❌ <b>User not found:</b> <code>${targetInput}</code>`);
          } else if (user.approved !== false) {
            await sendDirectMessage(chatId, `ℹ️ <b>User account <code>${user.username}</code> is already approved.</b>`);
          } else {
            user.approved = true;
            await saveUsers(users);
            const tgUser = message.from.username ? `@${message.from.username}` : message.from.first_name;
            await appendAuditLog({
              action: 'USER_APPROVED_VIA_TELEGRAM_COMMAND',
              username: tgUser,
              role: 'admin',
              details: `Approved account for ${user.username} via Telegram command`
            });
            await sendDirectMessage(chatId, `✅ <b>Account for <code>${user.username}</code> has been approved by ${tgUser}!</b>`);
          }
        }
      }

      else if (command === '/status') {
        const history = await loadHistory();
        const lastCheck = history[0]?.checkedAt
          ? new Date(history[0].checkedAt).toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })
          : 'Never';
        const dbStat = getDbStatus();

        const statusMsg = `ℹ️ <b>Sheets Bot Status</b>\n\n` +
          `• <b>Status:</b> Running 🟢\n` +
          `• <b>Database:</b> ${dbStat.connected ? 'Connected 🟢' : 'Disconnected 🔴'} (${dbStat.type})\n` +
          `• <b>Last Check:</b> <code>${lastCheck}</code>\n` +
          `• <b>Logs Count:</b> ${history.length} event(s)`;

        await sendDirectMessage(chatId, statusMsg);
      }

      else if (command === '/check') {
        await sendDirectMessage(chatId, '⏱ <b>Triggering manual check...</b>');
        if (runCheckCallback) {
          try {
            await runCheckCallback(false, true);
            await sendDirectMessage(chatId, '✅ <b>Check completed successfully!</b> Check dashboard or notifications for changes.');
          } catch (err) {
            await sendDirectMessage(chatId, `❌ <b>Error during check:</b> ${err.message}`);
          }
        } else {
          await sendDirectMessage(chatId, '❌ <b>Error:</b> Manual check trigger is not registered on the server.');
        }
      }

      else if (command === '/remind') {
        await sendDirectMessage(chatId, '⏱ <b>Triggering manual reminders check...</b>');
        if (runCheckCallback) {
          try {
            const res = await runCheckCallback(true, true);
            const count = res?.sentCount || 0;
            if (count > 0) {
              await sendDirectMessage(chatId, `✅ <b>Reminders check completed!</b> Sent ${count} 30-day reminder(s) to reminder channel.`);
            } else {
              await sendDirectMessage(chatId, '✅ <b>Reminders check completed!</b> No bookings require a 30-day reminder today.');
            }
          } catch (err) {
            await sendDirectMessage(chatId, `❌ <b>Error during check:</b> ${err.message}`);
          }
        } else {
          await sendDirectMessage(chatId, '❌ <b>Error:</b> Manual check trigger is not registered on the server.');
        }
      }

      else if (command === '/report') {
        const targetChat = REPORT_CHAT_ID || chatId;
        await sendDirectMessage(chatId, '⏱ <b>Generating 10-day customer report...</b>');
        try {
          const rows = await fetchAndEnrichSheetData();
          const previousSnapshot = await loadSnapshot();
          const prevMessages = previousSnapshot?.lastReportMessages || null;

          const { messages } = await sendWeeklyReport(rows, targetChat, 'manual', prevMessages);

          const { saveSnapshot } = require('./snapshot');
          const currentMonthRows = Object.values(previousSnapshot?.monthMap || {});
          await saveSnapshot(
            rows,
            currentMonthRows,
            previousSnapshot?.sentReminders || {},
            Date.now(),
            messages,
            previousSnapshot?.lastHousekeepingMessages || null,
            previousSnapshot?.lastHousekeepingReportTime || null
          );

          const count = messages.dateMessages ? Object.keys(messages.dateMessages).length : 0;
          if (targetChat !== chatId) {
            await sendDirectMessage(chatId, `✅ <b>Report sent to dedicated channel!</b> (${count} daily messages)`);
          } else {
            await sendDirectMessage(chatId, `✅ <b>Report sent!</b> (${count} daily messages)`);
          }
        } catch (err) {
          await sendDirectMessage(chatId, `❌ <b>Error generating report:</b> ${err.message}`);
        }
      }

      else if (command === '/housekeeping' || command === '/hk') {
        const parts = text.split(' ');
        const dateArg = parts[1] ? parts[1].trim().toLowerCase() : 'today';

        let targetDateStr;
        const now = new Date();
        const { toKLDateString, buildHousekeepingReport, formatHousekeepingDayMessage, appendHousekeepingTimestamp } = require('./housekeepingReport');

        if (dateArg === 'tomorrow' || dateArg === 'esok') {
          const tom = new Date(now);
          tom.setDate(now.getDate() + 1);
          targetDateStr = toKLDateString(tom);
        } else if (dateArg === 'today' || dateArg === 'hariini') {
          targetDateStr = toKLDateString(now);
        } else {
          const { parseDate } = require('./detector');
          const parsed = parseDate(dateArg);
          if (parsed) {
            targetDateStr = toKLDateString(parsed);
          } else {
            targetDateStr = toKLDateString(now);
          }
        }

        await sendDirectMessage(chatId, `⏱ <b>Generating housekeeping room list for ${targetDateStr}...</b>`);
        try {
          const rows = await fetchAndEnrichSheetData();
          const { applyOverridesToRows } = require('./overrides');
          const previousSnapshot = await loadSnapshot();
          const headers = previousSnapshot?.headers || (rows.length > 0 ? (rows[0].headers || rows[0]) : []);
          const enrichedRows = await applyOverridesToRows(rows, headers);

          const report = buildHousekeepingReport(enrichedRows, {
            startDateStr: targetDateStr,
            endDateStr: targetDateStr,
            filterType: 'both',
            headers
          });

          if (!report || report.days.length === 0) {
            await sendDirectMessage(chatId, `ℹ️ No housekeeping data found for ${targetDateStr}.`);
          } else {
            for (const day of report.days) {
              const baseMsg = formatHousekeepingDayMessage(day, { format: 'telegramHtml' });
              const msg = appendHousekeepingTimestamp(baseMsg, new Date(), 'telegramHtml');
              await sendDirectMessage(chatId, msg);
            }
          }
        } catch (err) {
          await sendDirectMessage(chatId, `❌ <b>Error generating housekeeping list:</b> ${err.message}`);
        }
      }

      else if (command === '/transfercheck' || command === '/transfer-check') {
        const targetChat = REPORT_CHAT_ID || chatId;
        const hkChatId = process.env.TELEGRAM_HOUSEKEEPING_CHAT_ID;
        await sendDirectMessage(chatId, '⏱ <b>Running transfer check...</b>');
        try {
          const rows = await fetchAndEnrichSheetData();
          const previousSnapshot = await loadSnapshot();
          const { detectChanges, findHeaderRowIndex } = require('./detector');
          const { sendHousekeepingAutoReport } = require('./housekeepingReport');

          const headerIndex = findHeaderRowIndex(rows);
          const currentMap = {};
          for (let i = headerIndex + 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.slice(0, -1).every(cell => !cell || cell.toString().trim() === '')) continue;
            const firstCell = (row[0] || '').toString().trim();
            const key = firstCell ? `${firstCell}__row${i}` : `row${i}`;
            currentMap[key] = { row, rowIndex: i };
          }

          const prevMap = previousSnapshot?.monthMap || {};
          const newKeys = Object.keys(currentMap).filter(k => !prevMap[k]);
          const modifiedKeys = Object.keys(currentMap).filter(k => {
            if (!prevMap[k]) return false;
            const prevRow = prevMap[k].row;
            const currRow = currentMap[k].row;
            const maxLen = Math.max(prevRow.length, currRow.length);
            for (let col = 0; col < maxLen; col++) {
              const before = (prevRow[col] || '').toString().trim();
              const after = (currRow[col] || '').toString().trim();
              if (before !== after) return true;
            }
            return false;
          });

          const hasChanges = newKeys.length > 0 || modifiedKeys.length > 0;

          if (!hasChanges) {
            await sendDirectMessage(chatId, 'ℹ️ <b>No changes detected.</b> All booking data is up to date.');
            return;
          }

          const newRows = newKeys.map(k => ({
            key: k,
            row: currentMap[k].row,
            rowIndex: currentMap[k].rowIndex,
            headers: rows[headerIndex] || [],
          }));
          const modifiedRows = modifiedKeys.map(k => ({
            key: k,
            row: currentMap[k].row,
            rowIndex: currentMap[k].rowIndex,
            headers: rows[headerIndex] || [],
            changes: [],
          }));

          if (affectsReportWindow(newRows, modifiedRows)) {
            const changedDates = getChangedDates(newRows, modifiedRows);
            const previousMessages = previousSnapshot?.lastReportMessages || null;
            const { messages } = await sendWeeklyReport(rows, targetChat, 'manual', previousMessages, changedDates);

            let hkMessages = previousSnapshot?.lastHousekeepingMessages || null;
            let hkTime = previousSnapshot?.lastHousekeepingReportTime || null;
            if (hkChatId) {
              const hkRes = await sendHousekeepingAutoReport(rows, hkChatId, 'manual', hkMessages, changedDates);
              hkMessages = hkRes.messages;
              hkTime = Date.now();
            }

            const { saveSnapshot } = require('./snapshot');
            const currentMonthRows = Object.values(previousSnapshot?.monthMap || {});
            await saveSnapshot(
              rows,
              currentMonthRows,
              previousSnapshot?.sentReminders || {},
              Date.now(),
              messages,
              hkMessages,
              hkTime
            );

            await sendDirectMessage(chatId, `✅ <b>Transfer & housekeeping reports updated!</b> 10-day reports have been checked and updated for changed dates.`);
          } else {
            await sendDirectMessage(chatId, `ℹ️ <b>Changes detected but outside 10-day window.</b>\nNew: ${newKeys.length} | Modified: ${modifiedKeys.length}`);
          }
        } catch (err) {
          await sendDirectMessage(chatId, `❌ <b>Error during transfer check:</b> ${err.message}`);
        }
      }

      else if (command === '/summary') {
        const snapshot = await loadSnapshot();
        if (!snapshot || !snapshot.monthMap || Object.keys(snapshot.monthMap).length === 0) {
          await sendDirectMessage(chatId, '📅 <b>No active bookings found for this month in snapshot.</b>');
          return;
        }

        const now = new Date();
        const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
        const bookings = Object.values(snapshot.monthMap);

        let msg = `📅 <b>Current Month Bookings (${monthName})</b>\n`;
        // Sort bookings by check-in date row index or checkin date representation
        bookings.forEach((b, i) => {
          if (i < 15) { // cap at 15 to fit in message
            const code = b.row[1] || '—';
            const name = b.row[3] || '—';
            const checkIn = b.row[7] || '—';
            msg += `\n${i+1}. <code>${code}</code>: <b>${name}</b> (In: ${checkIn})`;
          }
        });

        if (bookings.length > 15) {
          msg += `\n\n... and ${bookings.length - 15} more. View the dashboard for full details.`;
        }

        await sendDirectMessage(chatId, msg);
      }
    }
  }

  // ── 2. Handle Inline Button Clicks (Acknowledge) ──────────────────────────
  if (update.callback_query) {
    const callbackQuery = update.callback_query;
    const data = callbackQuery.data;
    const message = callbackQuery.message;
    const callbackQueryId = callbackQuery.id;

    if (data === 'noop_rec' || data === 'noop_div' || data === 'noop_approved' || data === 'noop_rejected') {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: 'This registration request has already been processed.'
          })
        });
      } catch (err) {}
      return;
    }

    // ── Handle User Registration Approval / Rejection ──
    if (data.startsWith('approve_user:') || data.startsWith('reject_user:')) {
      const isApprove = data.startsWith('approve_user:');
      const userId = data.substring(isApprove ? 13 : 12);
      const tgUser = callbackQuery.from.username
        ? `@${callbackQuery.from.username}`
        : `${callbackQuery.from.first_name} ${callbackQuery.from.last_name || ''}`.trim();

      const users = await loadUsers();
      const user = users.find(u => u.id === userId);

      if (isApprove) {
        if (!user) {
          try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: callbackQueryId, text: 'User not found or already deleted.' })
            });
          } catch {}
          return;
        }

        user.approved = true;
        await saveUsers(users);

        await appendAuditLog({
          action: 'USER_APPROVED_VIA_TELEGRAM_BUTTON',
          username: tgUser,
          role: 'admin',
          details: `Approved account for ${user.username} via Telegram button click`
        });

        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text: `Account ${user.username} Approved! ✅` })
          });
        } catch {}

        if (message) {
          const updatedText = message.text ? message.text.replace(/STATUS:.*$/m, `STATUS: ✅ <b>Approved by ${tgUser}</b>`) : `✅ Account ${user.username} approved by ${tgUser}`;
          const updatedMarkup = {
            inline_keyboard: [[{ text: `✅ Approved by ${tgUser}`, callback_data: 'noop_approved' }]]
          };
          try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: message.chat.id,
                message_id: message.message_id,
                text: updatedText,
                parse_mode: 'HTML',
                reply_markup: updatedMarkup
              })
            });
          } catch {}
        }
      } else {
        // Reject user
        const targetUsername = user ? user.username : 'User';
        const filteredUsers = users.filter(u => u.id !== userId);
        await saveUsers(filteredUsers);

        await appendAuditLog({
          action: 'USER_REJECTED_VIA_TELEGRAM_BUTTON',
          username: tgUser,
          role: 'admin',
          details: `Rejected & deleted account for ${targetUsername} via Telegram button click`
        });

        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text: `Account ${targetUsername} Rejected & Deleted ❌` })
          });
        } catch {}

        if (message) {
          const updatedText = message.text ? message.text.replace(/STATUS:.*$/m, `STATUS: ❌ <b>Rejected & Deleted by ${tgUser}</b>`) : `❌ Account ${targetUsername} rejected by ${tgUser}`;
          const updatedMarkup = {
            inline_keyboard: [[{ text: `❌ Rejected by ${tgUser}`, callback_data: 'noop_rejected' }]]
          };
          try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: message.chat.id,
                message_id: message.message_id,
                text: updatedText,
                parse_mode: 'HTML',
                reply_markup: updatedMarkup
              })
            });
          } catch {}
        }
      }
      return;
    }

    if (data.startsWith('ack_rec:') || data.startsWith('ack_div:')) {
      const isRec = data.startsWith('ack_rec:');
      const category = isRec ? 'reception' : 'dive_center';
      const catLabel = isRec ? 'Reception' : 'Dive Center';
      const eventId = data.substring(8);
      
      const username = callbackQuery.from.username
        ? `@${callbackQuery.from.username}`
        : `${callbackQuery.from.first_name} ${callbackQuery.from.last_name || ''}`.trim();

      console.log(`💬 Received Acknowledge ${category} click from Telegram user ${username} for event ${eventId}`);
      const success = await acknowledgeEvent(eventId, username, category);

      // Answer Callback Query so the Telegram UI stops loading
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: success ? `${catLabel} Acknowledged! ✅` : 'Already Acknowledged or Event Not Found'
          })
        });
      } catch (err) {}

      if (success && message) {
        // Fetch the updated event to see both fields
        const history = await loadHistory();
        const eventObj = history.find(item => item.id === eventId) || {};

        // Build the new reply markup
        const row = [];
        if (eventObj.acknowledgedReception) {
          row.push({
            text: `✅ Reception (${eventObj.acknowledgedReceptionBy})`,
            callback_data: 'noop_rec'
          });
        } else {
          row.push({
            text: '🛎 Reception',
            callback_data: `ack_rec:${eventId}`
          });
        }

        if (eventObj.acknowledgedDiveCenter) {
          row.push({
            text: `✅ Dive Center (${eventObj.acknowledgedDiveCenterBy})`,
            callback_data: 'noop_div'
          });
        } else {
          row.push({
            text: '🤿 Dive Center',
            callback_data: `ack_div:${eventId}`
          });
        }

        const replyMarkup = { inline_keyboard: [row] };

        // Edit the message reply markup (retains original HTML text format!)
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: message.chat.id,
              message_id: message.message_id,
              reply_markup: replyMarkup
            })
          });
        } catch (err) {
          console.error('   ❌ Failed to edit Telegram message reply markup:', err.message);
        }
      }
    }

    // ── Handle Report Verification ─────────────────────────────────────────
    if (data.startsWith('verify_report:')) {
      const parts = data.split(':');
      const eventId = parts[1];
      const dateStr = parts[2] || '';
      const verificationKey = dateStr ? `${eventId}:${dateStr}` : eventId;
      
      const username = callbackQuery.from.username
        ? `@${callbackQuery.from.username}`
        : `${callbackQuery.from.first_name} ${callbackQuery.from.last_name || ''}`.trim();

      console.log(`💬 Received Report Verify click from Telegram user ${username} for report ${verificationKey}`);

      // Answer Callback Query
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: `Report verified by ${username} ✅`
          })
        });
      } catch (err) {}

      // Store verification in history
      await appendVerification(verificationKey, username);

      // Get all verifications for this report
      const verifications = await getVerifications(verificationKey);

      // Update the message text to include verification info
      if (message && message.text) {
        const now = new Date();
        const timestamp = now.toLocaleString('en-US', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Kuala_Lumpur',
        });

        // Build verification section
        let verifySection = '\n\n━━━ ✅ VERIFIED ━━━\n';
        const lastV = verifications[verifications.length - 1];
        if (lastV) {
          const vTime = new Date(lastV.at).toLocaleString('en-US', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: 'Asia/Kuala_Lumpur',
          });
          verifySection += `  • Last verified by ${lastV.by} — ${vTime}\n`;
        }

        // Append to original message (remove old verification section if exists)
        let baseText = message.text;
        const verifyIdx = baseText.indexOf('\n\n━━━ ✅ VERIFIED ━━━');
        if (verifyIdx !== -1) {
          baseText = baseText.substring(0, verifyIdx);
        }

        const newText = baseText + verifySection;

        // Keep the verify button active for multiple people
        const callbackData = `verify_report:${eventId}${dateStr ? `:${dateStr}` : ''}`;
        const replyMarkup = {
          inline_keyboard: [
            [
              { text: `✅ Verify (${verifications.length})`, callback_data: callbackData }
            ]
          ]
        };

        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: message.chat.id,
              message_id: message.message_id,
              text: newText,
              parse_mode: 'HTML',
              reply_markup: replyMarkup
            })
          });
        } catch (err) {
          console.error('   ❌ Failed to edit report message text:', err.message);
        }
      }
    }
  }
}

/**
 * Initializes and starts the long-polling loop for Telegram updates.
 */
async function startTelegramListener(runCheckFn) {
  if (!BOT_TOKEN) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN not set. Telegram updates listener disabled.');
    return;
  }

  runCheckCallback = runCheckFn;
  console.log('🤖 Starting Telegram Updates Listener...');

  // Initialize offset by fetching the last pending update (so we don't replay old history)
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=1&offset=-1`);
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        lastUpdateId = data.result[0].update_id + 1;
      }
    }
  } catch (err) {
    console.error('⚠️ Failed to initialize Telegram update ID offset:', err.message);
  }

  // Poll Telegram updates serially (non-overlapping)
  async function pollUpdates() {
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId}&timeout=3`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.result) {
          for (const update of data.result) {
            lastUpdateId = update.update_id + 1;
            await handleTelegramUpdate(update);
          }
        }
      }
    } catch (err) {
      // Catch and ignore network connectivity fluctuations
    } finally {
      setTimeout(pollUpdates, 5000);
    }
  }

  // Start polling
  pollUpdates();
}

module.exports = { startTelegramListener, handleTelegramUpdate };
