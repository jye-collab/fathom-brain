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

// Backfill endpoint - loads all Fathom recordings into the brain
app.get('/backfill', async (req, res) => {
    res.json({ status: 'Backfill started - check Railway logs for progress' });
    try {
          const FATHOM_BASE = 'https://api.fathom.ai/external/v1';
          const headers = { 'X-Api-Key': config.fathom.apiKey, 'Content-Type': 'application/json' };

      console.log('Fetching all meetings from Fathom...');
          const callsRes = await fetch(`${FATHOM_BASE}/meetings`, { headers });
          const callsData = await callsRes.json();
          const calls = callsData.meetings || callsData.data || callsData || [];
          console.log(`Found ${calls.length} calls`);

      for (const call of calls) {
              try {
                        const callId = call.id || call.call_id;
                        console.log(`Processing: ${call.title || callId}`);

                const txRes = await fetch(`${FATHOM_BASE}/recordings/${callId}/transcript`, { headers });
                        const txData = await txRes.json();

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
          console.log(`\nð§  Fathom Brain running on port ${config.server.port}`);
    console.log(`   Backfill: http://localhost:${config.server.port}/backfill\n`);
                  });

startSlackBot();
