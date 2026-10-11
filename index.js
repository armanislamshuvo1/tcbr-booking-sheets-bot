require('dotenv').config();
const cron = require('node-cron');
const crypto = require('crypto');
const { startDashboard } = require('./src/dashboard');
const { startTelegramListener } = require('./src/telegramListener');
const { fetchAndEnrichSheetData, fetchSheetData } = require('./src/sheets');
const { detectChanges } = require('./src/detector');
const { sendTelegramAlert, isTelegramDisabled } = require('./src/telegram');
const { loadSnapshot, saveSnapshot, appendHistory, appendErrorLog, clearMonthData } = require('./src/snapshot');
const { checkAndSend30DayReminders } = require('./src/reminders');
const { sendWeeklyReport, affectsReportWindow, getChangedDates, buildReport, formatDayMessage } = require('./src/weeklyReport');
const { buildHousekeepingReport, formatHousekeepingDayMessage, sendHousekeepingAutoReport, toKLDateString } = require('./src/housekeepingReport');
const { isQuietHours, isReportQuietHours } = require('./src/quietHours');
const { getOrLoadConfig } = require('./src/adminController');

console.log('🤖 Sheets Monitor Bot starting...');

let isBoot = true;

// Error alert snoozing state
let lastErrorAlertTime = 0;
let lastErrorMessage = '';
let isRunning = false;
let retryTimeout = null;

// Weekly report state
const REPORT_CHAT_ID = process.env.TELEGRAM_REPORT_CHAT_ID;
const REPORT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown between change-triggered reports
let lastWeeklyReportTime = 0;
let lastReportMessages = null; // { headerId, dateMessages: { "YYYY-MM-DD": msgId } }
let pendingReportUpdate = false; // true when a report update was deferred due to quiet hours

// Housekeeping report state
const HK_CHAT_ID = process.env.TELEGRAM_HOUSEKEEPING_CHAT_ID;
let lastHousekeepingReportTime = 0;
let lastHousekeepingMessages = null; // { dateMessages: { "YYYY-MM-DD": msgId }, dateHashes: { "YYYY-MM-DD": hash } }
let pendingHousekeepingUpdate = false;

// ─── Channel configuration logging ──────────────────────────────────────────
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const REMINDER_CHANNEL_ID = process.env.TELEGRAM_REMINDER_CHANNEL_ID;

console.log('\n📡 System & Channel Configuration:');
console.log(`   NODE_ENV:                     ${process.env.NODE_ENV || 'production (default)'}`);
console.log(`   TELEGRAM NOTIFICATIONS:        ${isTelegramDisabled() ? '⚠️ DISABLED / SUPPRESSED (Dev Mode)' : '🟢 ENABLED'}`);
console.log(`   TELEGRAM_CHAT_ID:             ${CHAT_ID ? `${CHAT_ID.slice(0, 6)}...${CHAT_ID.slice(-4)}` : '❌ NOT SET'}`);
console.log(`   TELEGRAM_ADMIN_CHAT_ID:       ${ADMIN_CHAT_ID ? `${ADMIN_CHAT_ID.slice(0, 6)}...${ADMIN_CHAT_ID.slice(-4)}` : 'ℹ️ NOT SET (Falling back to TELEGRAM_CHAT_ID)'}`);
console.log(`   TELEGRAM_REPORT_CHAT_ID:      ${REPORT_CHAT_ID ? `${REPORT_CHAT_ID.slice(0, 6)}...${REPORT_CHAT_ID.slice(-4)}` : '❌ NOT SET'}`);
console.log(`   TELEGRAM_HOUSEKEEPING_CHAT_ID:${HK_CHAT_ID ? `${HK_CHAT_ID.slice(0, 6)}...${HK_CHAT_ID.slice(-4)}` : 'ℹ️ NOT SET (Auto-report disabled)'}`);
console.log(`   TELEGRAM_REMINDER_CHANNEL_ID: ${REMINDER_CHANNEL_ID ? `${REMINDER_CHANNEL_ID.slice(0, 6)}...${REMINDER_CHANNEL_ID.slice(-4)}` : '❌ NOT SET'}`);

if (!REPORT_CHAT_ID) {
  console.warn('⚠️  WARNING: TELEGRAM_REPORT_CHAT_ID is not set! Reports will fall back to TELEGRAM_CHAT_ID.');
} else if (REPORT_CHAT_ID === CHAT_ID) {
  console.warn('⚠️  WARNING: TELEGRAM_REPORT_CHAT_ID is the same as TELEGRAM_CHAT_ID. They should be different channels.');
} else if (REPORT_CHAT_ID === REMINDER_CHANNEL_ID) {
  console.warn('⚠️  WARNING: TELEGRAM_REPORT_CHAT_ID is the same as TELEGRAM_REMINDER_CHANNEL_ID! Reports will go to the reminder channel!');
}

// ─── Run check job ──────────────────────────────────────────────────────────
async function runCheck(forceReminders = false, isManual = false, retryCount = 0) {
  const currentRetry = typeof retryCount === 'number' ? retryCount : (retryCount ? 1 : 0);
  const botConfig = await getOrLoadConfig();
  if (botConfig.isPaused && !isManual) {
    console.log('   ⏸  Bot automated check loop is currently PAUSED by Admin. Skipping check.');
    return;
  }

  if (isRunning) {
    console.log('   ⚠️  A check is already running. Skipping this request.');
    return;
  }
  isRunning = true;

  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  const now = new Date();
  const retryText = currentRetry > 0 ? ` (Retry attempt ${currentRetry}/3)` : '';
  console.log(`\n[${now.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })}] ⏱  Running check...${retryText}`);
  
  const eventId = crypto.randomUUID();

  try {
    // 1. Fetch latest data from Google Sheet and enrich with Room details
    const rows = await fetchAndEnrichSheetData();
    console.log(`   📄 Fetched and enriched ${rows.length} total rows from sheet`);

    // 5. Load previous snapshot
    const previousSnapshot = await loadSnapshot();
    const isInitialRun = !previousSnapshot;

    let sentReminders = previousSnapshot?.sentReminders || {};
    let sentCount = 0;
    if (previousSnapshot?.lastWeeklyReportTime) {
      lastWeeklyReportTime = previousSnapshot.lastWeeklyReportTime;
    }
    if (previousSnapshot?.lastReportMessages) {
      lastReportMessages = previousSnapshot.lastReportMessages;
    }
    if (previousSnapshot?.lastHousekeepingReportTime) {
      lastHousekeepingReportTime = previousSnapshot.lastHousekeepingReportTime;
    }
    if (previousSnapshot?.lastHousekeepingMessages) {
      lastHousekeepingMessages = previousSnapshot.lastHousekeepingMessages;
    }
    if (forceReminders) {
      const remindersResult = await checkAndSend30DayReminders(rows, previousSnapshot);
      sentReminders = remindersResult.sentReminders;
      sentCount = remindersResult.sentCount || 0;
    }

    let offlineInfo = null;
    if (isBoot && previousSnapshot && previousSnapshot.savedAt) {
      const lastCheckTime = new Date(previousSnapshot.savedAt);
      const diffMs = now - lastCheckTime;
      const diffMins = Math.floor(diffMs / (1000 * 60));

      // If the bot has been inactive/offline for more than 10 minutes
      if (diffMins >= 10) {
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        const durationText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

        offlineInfo = {
          wasOffline: true,
          duration: durationText,
          lastActive: lastCheckTime.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })
        };
        console.log(`   ℹ️  Bot is back online! Was offline/inactive for ${durationText} (Last check was at ${offlineInfo.lastActive})`);
      }
    }

    // 3. Detect changes in current month
    const { newRows, modifiedRows, currentMonthRows } = detectChanges(rows, previousSnapshot);

    console.log(`   📅 Current month rows: ${currentMonthRows.length}`);
    console.log(`   🟢 New rows: ${newRows.length}`);
    console.log(`   🟡 Modified rows: ${modifiedRows.length}`);

    // 4. Send notification if there are changes (skip on first boot to prevent spam)
    if (!isInitialRun && (newRows.length > 0 || modifiedRows.length > 0)) {
      const { isQuiet: isAlertQuiet, klHour: alertKlHour } = isQuietHours();
      if (isAlertQuiet && !isManual) {
        console.log(`   ℹ️  Quiet hours (${alertKlHour}:00 KL): suppressing change notification.`);
      } else {
        await sendTelegramAlert({ newRows, modifiedRows, checkedAt: now, offlineInfo, eventId, chatId: CHAT_ID });
        console.log('   ✅ Telegram notification sent!');
      }
    } else {
      if (isInitialRun) {
        console.log('   ℹ️  Initial run: established baseline snapshot, skipped notifications.');
      } else {
        console.log('   ✅ No changes detected.');
      }
    }

    // 5. Log to history for dashboard
    await appendHistory({
      id: eventId,
      checkedAt: now.toISOString(),
      totalRows: rows.length,
      currentMonthCount: currentMonthRows.length,
      newRows: isInitialRun ? [] : newRows.map(r => ({ row: r.row, headers: r.headers, rowIndex: r.rowIndex })),
      modifiedRows: isInitialRun ? [] : modifiedRows.map(r => ({ row: r.row, headers: r.headers, rowIndex: r.rowIndex, changes: r.changes })),
      offlineInfo,
      note: isInitialRun ? 'Bot initialized. Established baseline snapshot.' : undefined
    });

    // 6. Check if report needs to be updated (sheet changes, override/content changes, date window shifted, or manual check)
    if (REPORT_CHAT_ID && !isInitialRun) {
      const hasChanges = (newRows.length > 0 || modifiedRows.length > 0);
      const reportData = buildReport(rows);

      // Check if generated report content differs from what is currently on Telegram
      let reportContentChanged = false;
      const lastHashes = lastReportMessages?.dateHashes || {};
      for (const day of reportData.days) {
        const dayText = formatDayMessage(reportData, day);
        const hash = crypto.createHash('md5').update(dayText).digest('hex');
        if (lastHashes[day.dateStr] !== hash) {
          reportContentChanged = true;
          break;
        }
      }

      const currentDates = reportData.days.map(d => d.dateStr);
      const lastDates = Object.keys(lastReportMessages?.dateMessages || {});
      // Only check forward: are there new dates in the current window not in lastReportMessages?
      // The backward check (old dates not in current window) is removed because dateMessages
      // accumulates entries from previous days, so lastDates always contains stale dates
      // that are no longer in the current 10-day window, causing false positives.
      const datesShifted = lastDates.length === 0 || 
                           currentDates.some(d => !lastDates.includes(d));

      // Restrict report updates during report quiet hours (10:00 PM to 10:00 AM KL time) to send at 10:00 AM
      const { isQuiet, klHour } = isReportQuietHours();

      if (isQuiet && !isManual) {
        // If there is a reason to update, flag it so the next non-quiet run picks it up
        if (datesShifted || reportContentChanged || (hasChanges && affectsReportWindow(newRows, modifiedRows))) {
          pendingReportUpdate = true;
        }
        console.log(`   ℹ️ Skipping report update check during quiet hours (${klHour}:00 KL time).`);
      } else if (isManual || forceReminders || pendingReportUpdate || datesShifted || reportContentChanged || (hasChanges && affectsReportWindow(newRows, modifiedRows))) {
        const nowMs = Date.now();
        const cooldownPassed = (nowMs - lastWeeklyReportTime > REPORT_COOLDOWN_MS);

        if (isManual || forceReminders || pendingReportUpdate || datesShifted || reportContentChanged || cooldownPassed) {
          try {
            const changedDates = getChangedDates(newRows, modifiedRows);
            console.log(`   📅 Updating report. Manual: ${isManual}, Forced: ${forceReminders}, ContentChanged: ${reportContentChanged}, Dates shifted: ${datesShifted}, Pending: ${pendingReportUpdate}, Changed dates: ${changedDates.join(', ')}`);

            const { messages } = await sendWeeklyReport(rows, REPORT_CHAT_ID, 'updated', lastReportMessages, changedDates);
            lastWeeklyReportTime = nowMs;
            lastReportMessages = messages;
            pendingReportUpdate = false;
            console.log('   ✅ Weekly/daily report updated successfully.');
          } catch (reportErr) {
            console.error('   ❌ Failed to update weekly/daily report:', reportErr.message);
            await appendErrorLog(reportErr, { source: 'Boat Transfer Report Auto-Update' });
          }
        }
      }
    }

    // 6b. Check if Housekeeping report needs to be updated (sheet changes, date window shifted, or content changed)
    if (HK_CHAT_ID && !isInitialRun) {
      const hasChanges = (newRows.length > 0 || modifiedRows.length > 0);
      const hkNow = new Date();
      const hkStartStr = toKLDateString(hkNow);
      const hkEndDate = new Date(hkNow);
      hkEndDate.setDate(hkNow.getDate() + 9);
      const hkEndStr = toKLDateString(hkEndDate);

      const hkReport = buildHousekeepingReport(rows, {
        startDateStr: hkStartStr,
        endDateStr: hkEndStr,
        filterType: 'both',
        sortBy: 'natural',
      });

      let hkContentChanged = false;
      const lastHkHashes = lastHousekeepingMessages?.dateHashes || {};
      for (const day of hkReport.days) {
        const dayText = formatHousekeepingDayMessage(day, { format: 'telegramHtml' });
        const hash = crypto.createHash('md5').update(dayText).digest('hex');
        if (lastHkHashes[day.dateStr] !== hash) {
          hkContentChanged = true;
          break;
        }
      }

      const currentHkDates = hkReport.days.map(d => d.dateStr);
      const lastHkDates = Object.keys(lastHousekeepingMessages?.dateMessages || {});
      const hkDatesShifted = lastHkDates.length === 0 || currentHkDates.some(d => !lastHkDates.includes(d));

      const { isQuiet, klHour } = isReportQuietHours();

      if (isQuiet && !isManual) {
        if (hkDatesShifted || hkContentChanged || (hasChanges && affectsReportWindow(newRows, modifiedRows))) {
          pendingHousekeepingUpdate = true;
        }
        console.log(`   ℹ️ Skipping housekeeping report update check during quiet hours (${klHour}:00 KL time).`);
      } else if (isManual || forceReminders || pendingHousekeepingUpdate || hkDatesShifted || hkContentChanged || (hasChanges && affectsReportWindow(newRows, modifiedRows))) {
        const nowMs = Date.now();
        const cooldownPassed = (nowMs - lastHousekeepingReportTime > REPORT_COOLDOWN_MS);

        if (isManual || forceReminders || pendingHousekeepingUpdate || hkDatesShifted || hkContentChanged || cooldownPassed) {
          try {
            const changedDates = getChangedDates(newRows, modifiedRows);
            console.log(`   🧹 Auto-updating Housekeeping Report on Telegram. Manual: ${isManual}, ContentChanged: ${hkContentChanged}, Dates shifted: ${hkDatesShifted}, Changed dates: ${changedDates.join(', ')}`);

            const { messages } = await sendHousekeepingAutoReport(rows, HK_CHAT_ID, 'updated', lastHousekeepingMessages, changedDates);
            lastHousekeepingReportTime = nowMs;
            lastHousekeepingMessages = messages;
            pendingHousekeepingUpdate = false;
            console.log('   ✅ Housekeeping report auto-updated successfully on Telegram.');
          } catch (hkErr) {
            console.error('   ❌ Failed to auto-update housekeeping report:', hkErr.message);
            await appendErrorLog(hkErr, { source: 'Housekeeping Report Auto-Update' });
          }
        }
      }
    }

    // 7. Save new snapshot
    await saveSnapshot(rows, currentMonthRows, sentReminders, lastWeeklyReportTime, lastReportMessages, lastHousekeepingMessages);

    // Reset error alerts state on success
    lastErrorAlertTime = 0;
    lastErrorMessage = '';

    return { sentCount };

  } catch (err) {
    console.error('   ❌ Error during check:', err.message);
    
    const errorMsg = err.message;
    const nowMs = now.getTime();
    const snoozeHours = parseInt(process.env.ERROR_ALERT_SNOOZE_HOURS || '6', 10);
    const snoozeMs = snoozeHours * 60 * 60 * 1000;

    const isSameError = (errorMsg === lastErrorMessage);
    const hasSnoozePassed = (nowMs - lastErrorAlertTime > snoozeMs);

    const retryStatus = currentRetry < 3
      ? `Attempt ${currentRetry + 1}/4 failed — retrying in 1m`
      : `Failed after all 4 attempts`;

    await appendErrorLog(err, {
      id: eventId,
      checkedAt: now.toISOString(),
      source: `Google Sheets Check (${retryStatus})`,
      details: err.stack || null,
      incrementCheck: true
    });

    if (currentRetry < 3) {
      const nextRetry = currentRetry + 1;
      console.log(`   ⚠️ Check failed (attempt ${currentRetry + 1}/4). Scheduling retry ${nextRetry}/3 in 1 minute...`);
      retryTimeout = setTimeout(() => runCheck(forceReminders, isManual, nextRetry), 60000);
    } else {
      console.log('   ❌ Check failed after 3 retries (4 total attempts).');
      if (!isSameError || hasSnoozePassed) {
        try {
          await sendTelegramAlert({ error: errorMsg, checkedAt: now, eventId, chatId: CHAT_ID });
          lastErrorAlertTime = nowMs;
          lastErrorMessage = errorMsg;
          console.log('   ✅ Telegram error alert sent (after 3 retries failed).');
        } catch (tgErr) {
          console.error('   ❌ Failed to send Telegram error alert:', tgErr.message);
          await appendErrorLog(tgErr, { source: 'Telegram Error Alert' });
        }
      } else {
        console.log(`   ℹ️ Telegram error alert snoozed (Same error within ${snoozeHours}h).`);
      }
    }
  } finally {
    isRunning = false;
    isBoot = false;
  }
}

// ─── Start dashboard server ─────────────────────────────────────────────────
startDashboard(runCheck);

// ─── Start Telegram listener ────────────────────────────────────────────────
startTelegramListener(runCheck);

// ─── Run once immediately on startup ────────────────────────────────────────
runCheck();

// ─── Schedule recurring checks ──────────────────────────────────────────────
const rawCron = process.env.CHECK_INTERVAL_CRON;
const cronExpression = (rawCron && !rawCron.includes('activate')) ? rawCron : '0 * * * *';
console.log(`\n📆 Scheduler set: "${cronExpression}"`);
cron.schedule(cronExpression, () => runCheck(false));

// Daily 30-day reminders & morning report update at 10:05 AM Kuala Lumpur time
console.log('📆 Daily 10:05 AM KL reminder & morning report job scheduled');
cron.schedule('5 10 * * *', async () => {
  console.log('\n⏰ [10:05 AM KL] Running daily 30-day reminders & morning report job...');
  await runCheck(true);
}, {
  timezone: 'Asia/Kuala_Lumpur'
});

// Monthly reset: clear history and snapshot on the 1st of each month at midnight KL time
console.log('📆 Monthly reset job scheduled (1st of each month at 12:00 AM KL)');
cron.schedule('0 0 1 * *', async () => {
  console.log('\n🗑️  [Monthly Reset] Clearing history and snapshot...');
  await clearMonthData();
  // Reset in-memory report state so the next run starts fresh
  lastWeeklyReportTime = 0;
  lastReportMessages = null;
  pendingReportUpdate = false;
  lastHousekeepingReportTime = 0;
  lastHousekeepingMessages = null;
  pendingHousekeepingUpdate = false;
  console.log('   ✅ Monthly reset complete. Next check will establish a new baseline.');
}, {
  timezone: 'Asia/Kuala_Lumpur'
});

// Weekly 10-day customer report: every Saturday at 10:05 AM KL time
if (REPORT_CHAT_ID) {
  console.log('📆 Weekly 10-day report job scheduled (Saturday 10:05 AM KL)');
  cron.schedule('5 10 * * 6', async () => {
    console.log('\n📋 [Saturday Report] Generating 10-day customer report...');
    const { isQuiet, klHour } = isReportQuietHours();
    if (isQuiet) {
      console.log(`   ℹ️ Skipping Saturday report during quiet hours (${klHour}:00 KL time).`);
      return;
    }
    try {
      const rows = await fetchAndEnrichSheetData();
      const snapshot = await loadSnapshot();
      const prevMessages = snapshot?.lastReportMessages || lastReportMessages;

      const { messages } = await sendWeeklyReport(rows, REPORT_CHAT_ID, 'scheduled', prevMessages);
      lastWeeklyReportTime = Date.now();
      lastReportMessages = messages;
      // Persist the updated time and message IDs while keeping the current month rows intact
      const currentMonthRows = Object.values(snapshot?.monthMap || {});
      await saveSnapshot(rows, currentMonthRows, snapshot?.sentReminders || {}, lastWeeklyReportTime, lastReportMessages);
      console.log('   ✅ Saturday report sent successfully.');
    } catch (err) {
      console.error('   ❌ Saturday report failed:', err.message);
      await appendErrorLog(err, { source: 'Saturday Weekly Report' });
    }
  }, {
    timezone: 'Asia/Kuala_Lumpur'
  });
} else {
  console.log('⚠️  TELEGRAM_REPORT_CHAT_ID not set. Weekly report job disabled.');
}

// ─── Global Unhandled Error Logging ─────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('   ❌ Unhandled Rejection:', reason);
  appendErrorLog(reason, { source: 'Unhandled Promise Rejection' });
});

process.on('uncaughtException', (err) => {
  console.error('   ❌ Uncaught Exception:', err);
  appendErrorLog(err, { source: 'Uncaught Exception' });
});

console.log('🌐 Dashboard: http://localhost:' + (process.env.DASHBOARD_PORT || 3000));
console.log('👋 Bot is running. Press Ctrl+C to stop.\n');
