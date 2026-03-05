// === CRASH HANDLERS ===
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('SIGTERM', () => {
  console.error('>>> RECEIVED SIGTERM');
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

function memMB() {
  var m = process.memoryUsage();
  return 'heap=' + Math.round(m.heapUsed / 1048576) + 'MB rss=' + Math.round(m.rss / 1048576) + 'MB';
}

// Direct OpenAI call with fetch — no SDK needed, saves ~50MB RAM
async function getEmbedding(text, apiKey) {
  var r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    var errText = await r.text();
    throw new Error('Embed API ' + r.status + ': ' + errText.slice(0, 200));
  }
  var json = await r.json();
  var vec = json.data[0].embedding;
  json = null;
  return vec;
}

async function runBackfill() {
  // Only import config + supabase — NO openai SDK, NO ingest.js
  var { config } = await import('./src/config.js');
  var { supabase } = await import('./src/supabase.js');

  console.log('Backfill starting. ' + memMB());

  var OPENAI_KEY = config.openai.apiKey;
  var FATHOM_BASE = 'https://api.fathom.ai/external/v1';
  var fathomHeaders = { 'X-Api-Key': config.fathom.apiKey, 'Content-Type': 'application/json' };

  await supabase.from('meetings').delete().is('fathom_call_id', null);

  var cursor = null, page = 1;
  var ok = 0, skip = 0, fail = 0, total = 0;
  var seenIds = new Set();

  while (true) {
    var url = FATHOM_BASE + '/meetings' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '');
    console.log('--- Page ' + page + ' --- ' + memMB());

    var items, nextCursor;
    try {
      var res = await fetch(url, { headers: fathomHeaders, signal: AbortSignal.timeout(30000) });
      var raw = await res.text();
      var parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.meetings || parsed.data || parsed.recordings || []);
      nextCursor = parsed.next_cursor || parsed.nextCursor || null;
      raw = null; parsed = null;
    } catch (e) {
      console.error('Page fetch error: ' + e.message);
      break;
    }

    if (!items.length) break;
    console.log(items.length + ' items');

    var dupsOnPage = 0;
    for (var c = 0; c < items.length; c++) {
      var call = items[c];
      total++;
      var callId = call.recording_id || call.id || call.call_id;

      // Dedup: skip if we've already processed this meeting
      if (seenIds.has(callId)) {
        dupsOnPage++;
        console.log('(' + total + ') SKIP DUP: ' + (call.title || callId));
        continue;
      }
      seenIds.add(callId);

      try {
        console.log('(' + total + ') ' + (call.title || callId));

        // Get transcript
        console.log('  fetching transcript...');
        var txRes = await fetch(FATHOM_BASE + '/recordings/' + callId + '/transcript', { headers: fathomHeaders, signal: AbortSignal.timeout(30000) });
        var txRaw = await txRes.text();
        var txData;
        try { txData = JSON.parse(txRaw); } catch (e) { txData = txRaw; }
        txRaw = null;

        var transcript = '';
        if (typeof txData === 'string') transcript = txData;
        else if (txData.transcript) {
          if (typeof txData.transcript === 'string') {
            transcript = txData.transcript;
          } else if (Array.isArray(txData.transcript)) {
            // Fathom returns array of {speaker: {display_name, ...}, text: "..."}
            transcript = txData.transcript.map(function (s) {
              var name = '';
              if (typeof s.speaker === 'string') name = s.speaker;
              else if (s.speaker && s.speaker.display_name) name = s.speaker.display_name;
              else if (s.speaker && s.speaker.name) name = s.speaker.name;
              return (name ? name + ': ' : '') + (s.text || s.content || '');
            }).join('\n');
          } else {
            transcript = JSON.stringify(txData.transcript);
          }
        }
        else if (txData.text) transcript = txData.text;
        else if (Array.isArray(txData)) transcript = txData.map(function (s) {
          var name = '';
          if (typeof s.speaker === 'string') name = s.speaker;
          else if (s.speaker && s.speaker.display_name) name = s.speaker.display_name;
          else if (s.speaker && s.speaker.name) name = s.speaker.name;
          return (name ? name + ': ' : '') + (s.text || s.content || '');
        }).join('\n');
        else transcript = JSON.stringify(txData);
        txData = null;

        if (transcript.length < 50) {
          console.log('  skip (' + transcript.length + ' chars)');
          skip++;
          transcript = null;
          continue;
        }

        // Upsert meeting
        var r1 = await supabase.from('meetings').upsert({
          fathom_call_id: callId,
          title: call.title || 'Untitled',
          date: call.started_at || call.date || call.created_at || new Date().toISOString(),
          duration_seconds: call.duration || call.duration_seconds || 0,
          attendees: call.attendees || [],
          summary: call.summary || '',
          full_transcript: transcript,
        }, { onConflict: 'fathom_call_id' });
        if (r1.error) throw new Error('Upsert: ' + r1.error.message);

        // Get meeting ID
        var r2 = await supabase.from('meetings').select('id').eq('fathom_call_id', callId).single();
        if (r2.error) throw new Error('Select: ' + r2.error.message);
        var meetingId = r2.data.id;

        // Delete old chunks
        await supabase.from('chunks').delete().eq('meeting_id', meetingId);

        // Chunk + embed + insert inline (no array, no extra imports)
        var dateStr = new Date(call.started_at || call.date || call.created_at || Date.now())
          .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        var prefix = '[Meeting: "' + (call.title || 'Untitled') + '" on ' + dateStr + ']\n\n';
        var maxC = 2000, overlap = 200;
        var pos = 0, chunkIdx = 0;

        while (pos < transcript.length) {
          var end = pos + maxC;
          if (end < transcript.length) {
            var bp = Math.max(transcript.lastIndexOf('. ', end), transcript.lastIndexOf('\n', end));
            if (bp > pos + maxC * 0.5) end = bp + 1;
          } else end = transcript.length;

          var chunkContent = prefix + transcript.slice(pos, end).trim();
          // If this chunk reaches the end, don't subtract overlap — avoids infinite loop
          if (end >= transcript.length) {
            pos = transcript.length;
          } else {
            pos = end - overlap;
          }

          if (chunkContent.length <= prefix.length + 10) {
            if (pos >= transcript.length) break;
            continue;
          }

          var embedding = await getEmbedding(chunkContent, OPENAI_KEY);

          var ri = await supabase.from('chunks').insert({
            meeting_id: meetingId,
            chunk_index: chunkIdx,
            content: chunkContent,
            token_count: Math.ceil(chunkContent.length / 4),
            embedding: embedding,
          });
          if (ri.error) throw new Error('Chunk ' + chunkIdx + ': ' + ri.error.message);

          embedding = null;
          chunkContent = null;
          chunkIdx++;

          if (pos >= transcript.length) break;
        }

        transcript = null;
        ok++;
        console.log('  OK — ' + chunkIdx + ' chunks (' + ok + ' total) ' + memMB());

        await new Promise(function (r) { setTimeout(r, 300); });
      } catch (err) {
        fail++;
        console.error('  ERR: ' + err.message);
      }
    }

    var pageSize = items.length;
    items = null;
    var newOnPage = pageSize - dupsOnPage;
    console.log('Page ' + page + ': ' + newOnPage + ' new, ' + dupsOnPage + ' dups');

    // Safety: if entire page was duplicates, API is cycling — stop
    if (newOnPage === 0) {
      console.log('Full page of duplicates — API is cycling. Stopping.');
      break;
    }

    cursor = nextCursor;
    if (!cursor) { console.log('No more pages.'); break; }
    page++;
  }

  console.log('=== DONE === ok=' + ok + ' skip=' + skip + ' fail=' + fail + ' total=' + total);
}

app.get('/backfill', async (req, res) => {
  if (!BACKFILL_MODE) return res.json({ error: 'Set BACKFILL_MODE=1 first' });
  res.json({ status: 'Backfill started' });
  await runBackfill();
});

// --- Tella debug endpoint (see what API returns) ---
app.get('/debug/tella', async (req, res) => {
  try {
    var { config } = await import('./src/config.js');
    var key = config.tella.apiKey;
    if (!key) return res.json({ error: 'TELLA_API_KEY not set' });

    var r = await fetch('https://api.tella.com/v1/videos?limit=3', {
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    var text = await r.text();
    var status = r.status;

    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }

    if (parsed && parsed.data) {
      // Show structure of first video (redact long fields)
      var sample = parsed.data[0];
      if (sample && sample.transcript) {
        sample._transcriptKeys = Object.keys(sample.transcript);
        sample._transcriptType = typeof sample.transcript;
        if (sample.transcript.sentences) sample._sentenceCount = sample.transcript.sentences.length;
        if (sample.transcript.text) sample._textLen = sample.transcript.text.length;
      }
      res.json({ status: status, videoCount: parsed.data.length, sampleKeys: sample ? Object.keys(sample) : [], sample: sample, pagination: { cursor: parsed.cursor || parsed.next_cursor || null } });
    } else {
      res.json({ status: status, raw: text.slice(0, 2000) });
    }
  } catch (err) {
    res.json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
});

// --- Tella ingestion endpoint ---
app.get('/ingest/tella', async (req, res) => {
  try {
    var { ingestTella } = await import('./src/tella.js');
    // Don't respond immediately — wait for result so we can return errors
    var result = await ingestTella();
    console.log('[tella] Ingestion complete:', JSON.stringify(result));
    res.json({ status: 'done', result: result });
  } catch (err) {
    console.error('[tella] Ingestion error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// --- Self-improvement endpoint (trigger manually or via cron) ---
app.get('/self-improve', async (req, res) => {
  res.json({ status: 'Self-improvement cycle started' });
  try {
    var { runSelfImprovement } = await import('./src/soul.js');
    await runSelfImprovement();
    console.log('[self-improve] Manual trigger complete.');
  } catch (err) {
    console.error('[self-improve] Error:', err.message);
  }
});

app.listen(PORT, async function () {
  console.log('Fathom Brain on port ' + PORT + ' — ' + (BACKFILL_MODE ? 'BACKFILL' : 'NORMAL'));

  if (BACKFILL_MODE) {
    console.log('Starting backfill in 3s...');
    setTimeout(async function () {
      try { await runBackfill(); }
      catch (err) { console.error('Backfill failed:', err.message); }
    }, 3000);
  } else {
    try {
      var { createWebhookRouter } = await import('./src/webhook.js');
      app.use('/webhook', createWebhookRouter());
      var { startSlackBot } = await import('./src/slack-bot.js');
      startSlackBot();

      // --- Self-improvement loop: every 48 hours ---
      var SELF_IMPROVE_INTERVAL = 48 * 60 * 60 * 1000; // 48 hours in ms
      console.log('🧠 Self-improvement loop: every 48 hours');

      // Run first self-improvement 60 seconds after startup
      setTimeout(async function () {
        try {
          var { runSelfImprovement } = await import('./src/soul.js');
          await runSelfImprovement();
        } catch (err) {
          console.error('[self-improve] Startup run error:', err.message);
        }
      }, 60000);

      // Then every 48 hours
      setInterval(async function () {
        try {
          console.log('[self-improve] Running scheduled self-improvement...');
          var { runSelfImprovement } = await import('./src/soul.js');
          await runSelfImprovement();
        } catch (err) {
          console.error('[self-improve] Scheduled run error:', err.message);
        }
      }, SELF_IMPROVE_INTERVAL);

    } catch (err) {
      console.error('Slack bot failed:', err.message);
    }
  }
});
