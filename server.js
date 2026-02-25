// === CRASH HANDLERS — must be first ===
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('SIGTERM', () => {
  console.error('>>> RECEIVED SIGTERM — Railway is restarting this container');
  process.exit(0);
});

import express from 'express';

var BACKFILL_MODE = process.env.BACKFILL_MODE === '1';
var PORT = parseInt(process.env.PORT || '3000', 10);

var app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
    res.json({ name: 'Fathom Brain', status: 'running', mode: BACKFILL_MODE ? 'backfill' : 'normal' });
});

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

async function runBackfill() {
  var { config } = await import('./src/config.js');
  var { supabase } = await import('./src/supabase.js');
  var { ingestMeeting } = await import('./src/ingest.js');

  // Clean up NULL rows
  var { error: cleanErr } = await supabase.from('meetings').delete().is('fathom_call_id', null);
  if (cleanErr) console.error('Cleanup error:', cleanErr.message);
  else console.log('Cleaned up NULL fathom_call_id rows');

  var FATHOM_BASE = 'https://api.fathom.ai/external/v1';
  var headers = { 'X-Api-Key': config.fathom.apiKey, 'Content-Type': 'application/json' };

  // Fetch ALL meetings with pagination
  var allCalls = [];
  var cursor = null;
  var page = 1;
  while (true) {
    var url = FATHOM_BASE + '/meetings';
    if (cursor) url = url + '?next_cursor=' + encodeURIComponent(cursor);
    console.log('Fetching meetings page ' + page + '...');
    var callsRes = await fetch(url, { headers: headers });
    var callsData = await callsRes.json();
    var items = Array.isArray(callsData) ? callsData : (callsData.items || callsData.meetings || callsData.data || callsData.recordings || []);
    allCalls = allCalls.concat(items);
    console.log('  Got ' + items.length + ' meetings (total so far: ' + allCalls.length + ')');

    // Check for next page
    cursor = callsData.next_cursor || callsData.nextCursor || null;
    if (!cursor || items.length === 0) break;
    page++;
  }

  console.log('Total meetings found: ' + allCalls.length);

  var successCount = 0;
  var skipCount = 0;
  var errorCount = 0;

  for (var c = 0; c < allCalls.length; c++) {
    var call = allCalls[c];
    try {
      var callId = call.recording_id || call.id || call.call_id;
      console.log('(' + (c + 1) + '/' + allCalls.length + ') Processing: ' + (call.title || callId));
      var txUrl = FATHOM_BASE + '/recordings/' + callId + '/transcript';
      var txRes = await fetch(txUrl, { headers: headers });
      var txText = await txRes.text();
      var txData;
      try { txData = JSON.parse(txText); } catch(e) { txData = txText; }

      var transcript = '';
      if (typeof txData === 'string') transcript = txData;
      else if (txData.transcript) transcript = typeof txData.transcript === 'string' ? txData.transcript : JSON.stringify(txData.transcript);
      else if (txData.text) transcript = txData.text;
      else if (Array.isArray(txData)) transcript = txData.map(function(s) { return (s.speaker || 'Speaker') + ': ' + (s.text || s.content || ''); }).join('\n');
      else transcript = JSON.stringify(txData);

      console.log('  Transcript: ' + transcript.length + ' chars');

      if (transcript.length < 50) {
        console.log('  Skipping (too short)');
        skipCount++;
        continue;
      }

      await ingestMeeting({
        fathomCallId: callId,
        title: call.title || 'Untitled Meeting',
        date: call.started_at || call.date || call.created_at || new Date().toISOString(),
        transcript: transcript,
        summary: call.summary || '',
        attendees: call.attendees || [],
        durationSeconds: call.duration || call.duration_seconds || 0,
      });

      // Free memory
      transcript = null;
      txData = null;
      txText = null;

      successCount++;
      console.log('  Done (' + successCount + ' completed)');

      // Brief pause between meetings
      await new Promise(function(r) { setTimeout(r, 300); });
    } catch (err) {
      errorCount++;
      console.error('  ERROR: ' + err.message);
    }
  }

  console.log('=== BACKFILL COMPLETE ===');
  console.log('  Success: ' + successCount);
  console.log('  Skipped: ' + skipCount);
  console.log('  Errors: ' + errorCount);
  console.log('  Total: ' + allCalls.length);
}

// Backfill endpoint
app.get('/backfill', async (req, res) => {
    if (!BACKFILL_MODE) {
      res.json({ error: 'Set BACKFILL_MODE=1 in Railway env vars and redeploy first. This disables the Slack bot to free memory for processing.' });
      return;
    }
    res.json({ status: 'Backfill started - check Railway logs' });
    await runBackfill();
});

app.listen(PORT, async function() {
    console.log('Fathom Brain running on port ' + PORT);
    console.log('Mode: ' + (BACKFILL_MODE ? 'BACKFILL (Slack bot disabled to save memory)' : 'NORMAL'));

    if (BACKFILL_MODE) {
      // Auto-run backfill after brief delay, no Slack bot
      console.log('Auto-starting backfill in 3 seconds...');
      setTimeout(async function() {
        try {
          await runBackfill();
          console.log('Done! Remove BACKFILL_MODE env var and redeploy to resume Slack bot.');
        } catch (err) {
          console.error('Backfill failed:', err.message);
        }
      }, 3000);
    } else {
      // Normal mode — load Slack bot
      try {
        var { createWebhookRouter } = await import('./src/webhook.js');
        app.use('/webhook', createWebhookRouter());
        var { startSlackBot } = await import('./src/slack-bot.js');
        startSlackBot();
      } catch (err) {
        console.error('Slack bot failed to start:', err.message);
      }
    }
});
