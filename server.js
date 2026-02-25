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

  var { error: cleanErr } = await supabase.from('meetings').delete().is('fathom_call_id', null);
  if (cleanErr) console.error('Cleanup error:', cleanErr.message);
  else console.log('Cleaned up NULL fathom_call_id rows');

  var FATHOM_BASE = 'https://api.fathom.ai/external/v1';
  var headers = { 'X-Api-Key': config.fathom.apiKey, 'Content-Type': 'application/json' };

  var cursor = null;
  var page = 1;
  var successCount = 0;
  var skipCount = 0;
  var errorCount = 0;
  var totalProcessed = 0;

  while (true) {
    var url = FATHOM_BASE + '/meetings';
    if (cursor) url = url + '?next_cursor=' + encodeURIComponent(cursor);

    console.log('--- Fetching page ' + page + ' ---');

    var items = [];
    var nextCursor = null;

    try {
      var callsRes = await fetch(url, { headers: headers });
      var rawText = await callsRes.text();
      var callsData = JSON.parse(rawText);
      items = Array.isArray(callsData) ? callsData : (callsData.items || callsData.meetings || callsData.data || callsData.recordings || []);
      nextCursor = callsData.next_cursor || callsData.nextCursor || null;
    } catch (fetchErr) {
      console.error('Failed to fetch page ' + page + ': ' + fetchErr.message);
      break;
    }

    console.log('Got ' + items.length + ' meetings on this page');
    if (items.length === 0) break;

    // Process this page immediately
    for (var c = 0; c < items.length; c++) {
      var call = items[c];
      totalProcessed++;
      try {
        var callId = call.recording_id || call.id || call.call_id;
        console.log('(' + totalProcessed + ') ' + (call.title || callId));

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

        if (transcript.length < 50) {
          console.log('  Skip (too short: ' + transcript.length + ' chars)');
          skipCount++;
          continue;
        }

        console.log('  ' + transcript.length + ' chars, ingesting...');

        await ingestMeeting({
          fathomCallId: callId,
          title: call.title || 'Untitled Meeting',
          date: call.started_at || call.date || call.created_at || new Date().toISOString(),
          transcript: transcript,
          summary: call.summary || '',
          attendees: call.attendees || [],
          durationSeconds: call.duration || call.duration_seconds || 0,
        });

        transcript = null;
        txData = null;
        txText = null;

        successCount++;
        console.log('  OK (' + successCount + ' done)');

        await new Promise(function(r) { setTimeout(r, 300); });
      } catch (err) {
        errorCount++;
        console.error('  ERROR: ' + err.message);
      }
    }

    // Move to next page
    cursor = nextCursor;
    if (!cursor) {
      console.log('No more pages.');
      break;
    }
    page++;
  }

  console.log('=== BACKFILL COMPLETE ===');
  console.log('  Success: ' + successCount);
  console.log('  Skipped: ' + skipCount);
  console.log('  Errors: ' + errorCount);
  console.log('  Total: ' + totalProcessed);
}

app.get('/backfill', async (req, res) => {
    if (!BACKFILL_MODE) {
      res.json({ error: 'Set BACKFILL_MODE=1 in Railway env vars and redeploy first.' });
      return;
    }
    res.json({ status: 'Backfill started - check Railway logs' });
    await runBackfill();
});

app.listen(PORT, async function() {
    console.log('Fathom Brain running on port ' + PORT);
    console.log('Mode: ' + (BACKFILL_MODE ? 'BACKFILL (Slack bot disabled)' : 'NORMAL'));

    if (BACKFILL_MODE) {
      console.log('Auto-starting backfill in 3 seconds...');
      setTimeout(async function() {
        try {
          await runBackfill();
          console.log('Done! Remove BACKFILL_MODE env var and redeploy for normal Slack bot.');
        } catch (err) {
          console.error('Backfill failed:', err.message);
        }
      }, 3000);
    } else {
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
