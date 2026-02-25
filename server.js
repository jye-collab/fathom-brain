import express from 'express';
import { startSlackBot } from './src/slack-bot.js';
import { createWebhookRouter } from './src/webhook.js';
import { ingestMeeting } from './src/ingest.js';
import { config } from './src/config.js';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/webhook', createWebhookRouter());

app.get('/', (req, res) => {
    res.json({ name: 'Fathom Brain', status: 'running' });
});

// Debug: raw Fathom API response
  app.get('/test-api', async (req, res) => {
    try {
      const FATHOM_BASE = 'https://api.fathom.ai/external/v1';
      const hdrs = { 'X-Api-Key': config.fathom.apiKey };
      const r = await fetch(FATHOM_BASE + '/meetings', { headers: hdrs });
      const body = await r.json();
      res.json({ httpStatus: r.status, apiKeySet: !!config.fathom.apiKey, keyLen: (config.fathom.apiKey||'').length, responseKeys: Object.keys(body), itemsCount: body.items ? body.items.length : 'no items key', firstItem: body.items && body.items[0] ? body.items[0] : null, raw: body });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // Backfill endpoint - loads all Fathom recordings into the brain
app.get('/backfill', async (req, res) => {
    res.json({ status: 'Backfill started - check Railway logs for progress' });
    try {
          const FATHOM_BASE = 'https://api.fathom.ai/external/v1';
          const headers = { 'X-Api-Key': config.fathom.apiKey, 'Content-Type': 'application/json' };

      console.log('Fetching all meetings from Fathom...');
          const callsRes = await fetch(`${FATHOM_BASE}/meetings`, { headers });
          const callsData = await callsRes.json();
          const calls = Array.isArray(callsData) ? callsData : (callsData.items || callsData.meetings || callsData.data || callsData.recordings || []);
          console.log('API response keys:', Object.keys(callsData));
        console.log(`Found ${calls.length} meetings`);

      for (const call of calls) {
              try {
          const callId = call.recording_id || call.id || call.call_id;
                        console.log(`Processing: ${call.title || callId}`);

                const txUrl = `${FATHOM_BASE}/recordings/${callId}/transcript`;
          console.log('Fetching transcript from:', txUrl);
          const txRes = await fetch(txUrl, { headers });
                        const txText = await txRes.text();
          let txData;
          try { txData = JSON.parse(txText); } catch(e) { txData = txText; }

                let transcript = '';
                        if (typeof txData === 'string') transcript = txData;
                        else if (txData.transcript) transcript = typeof txData.transcript === 'string' ? txData.transcript : JSON.stringify(txData.transcript);
                        else if (txData.text) transcript = txData.text;
                        else if (Array.isArray(txData)) transcript = txData.map(s => `${s.speaker || 'Speaker'}: ${s.text || s.content || ''}`).join('\n');
                        else transcript = JSON.stringify(txData);

                if (transcript.length < 50) {
                            console.log(`  Skipping (transcript too short: ${transcript.length} chars)`);
                            continue;
                }

                await ingestMeeting({
                            callId,
                            title: call.title || 'Untitled Meeting',
                            date: call.started_at || call.date || call.created_at || new Date().toISOString(),
                            transcript,
                            summary: call.summary || '',
                            attendees: call.attendees || [],
                            durationSeconds: call.duration || call.duration_seconds || 0,
      });

                console.log(`  Done!`);
                        await new Promise(r => setTimeout(r, 500));
              } catch (err) {
                        console.error(`  Error processing call: ${err.message}`)
              }
      }
          console.log('Backfill complete!');
} catch (err) {
      console.error('Backfill failed:', err);
    }
});

app.listen(config.server.port, () => {
          console.log(`\nÃ°ÂÂ§Â  Fathom Brain running on port ${config.server.port}`);
    console.log(`   Backfill: http://localhost:${config.server.port}/backfill\n`);
                  });

startSlackBot();
