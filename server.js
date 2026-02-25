import express from 'express';
import { startSlackBot } from './src/slack-bot.js';
import { createWebhookRouter } from './src/webhook.js';
import { ingestMeeting } from './src/ingest.js';
import { generateEmbedding } from './src/embeddings.js';
import { config } from './src/config.js';
import { supabase } from './src/supabase.js';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/webhook', createWebhookRouter());

app.get('/', (req, res) => {
    res.json({ name: 'Fathom Brain', status: 'running' });
});

// Test OpenAI embedding
app.get('/test-embed', async (req, res) => {
    try {
        console.log('Testing embedding...');
        console.log('OpenAI key set:', !!config.openai.apiKey);
        console.log('OpenAI key length:', (config.openai.apiKey||'').length);
        console.log('Embedding model:', config.openai.embeddingModel);
        const emb = await generateEmbedding('Hello world test');
        console.log('Embedding result type:', typeof emb);
        console.log('Embedding length:', emb ? emb.length : 'null');
        res.json({ success: true, embeddingLength: emb ? emb.length : 0, first5: emb ? emb.slice(0,5) : null });
    } catch (err) {
        console.error('Embedding test failed:', err.message, err.stack);
        res.json({ success: false, error: err.message, stack: err.stack });
    }
});

// Test Supabase insert
app.get('/test-supabase', async (req, res) => {
    try {
        const { data, error } = await supabase.from('meetings').select('id, title, fathom_call_id').limit(5);
        if (error) return res.json({ success: false, error: error.message });
        res.json({ success: true, meetings: data });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
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

// Backfill endpoint with better error logging
app.get('/backfill', async (req, res) => {
    res.json({ status: 'Backfill started - check Railway logs for progress' });
    try {
      // First clean up any NULL fathom_call_id rows
      const { error: cleanErr } = await supabase.from('meetings').delete().is('fathom_call_id', null);
      if (cleanErr) console.error('Cleanup error:', cleanErr.message);
      else console.log('Cleaned up NULL fathom_call_id rows');

      const FATHOM_BASE = 'https://api.fathom.ai/external/v1';
      const headers = { 'X-Api-Key': config.fathom.apiKey, 'Content-Type': 'application/json' };
      console.log('Fetching all meetings from Fathom...');
      const callsRes = await fetch(FATHOM_BASE + '/meetings', { headers });
      const callsData = await callsRes.json();
      const calls = Array.isArray(callsData) ? callsData : (callsData.items || callsData.meetings || callsData.data || callsData.recordings || []);
      console.log('Found ' + calls.length + ' meetings');

      for (const call of calls) {
        try {
          const callId = call.recording_id || call.id || call.call_id;
          console.log('Processing: ' + (call.title || callId));
          const txUrl = FATHOM_BASE + '/recordings/' + callId + '/transcript';
          console.log('Fetching transcript from:', txUrl);
          const txRes = await fetch(txUrl, { headers });
          const txText = await txRes.text();
          let txData;
          try { txData = JSON.parse(txText); } catch(e) { txData = txText; }

          let transcript = '';
          if (typeof txData === 'string') transcript = txData;
          else if (txData.transcript) transcript = typeof txData.transcript === 'string' ? txData.transcript : JSON.stringify(txData.transcript);
          else if (txData.text) transcript = txData.text;
          else if (Array.isArray(txData)) transcript = txData.map(function(s) { return (s.speaker || 'Speaker') + ': ' + (s.text || s.content || ''); }).join('\n');
          else transcript = JSON.stringify(txData);

          console.log('  Transcript length: ' + transcript.length + ' chars');

          if (transcript.length < 50) {
            console.log('  Skipping (transcript too short)');
            continue;
          }

          console.log('  Calling ingestMeeting...');
          await ingestMeeting({
            fathomCallId: callId,
            title: call.title || 'Untitled Meeting',
            date: call.started_at || call.date || call.created_at || new Date().toISOString(),
            transcript: transcript,
            summary: call.summary || '',
            attendees: call.attendees || [],
            durationSeconds: call.duration || call.duration_seconds || 0,
          });

          console.log('  Done with: ' + (call.title || callId));
          await new Promise(function(r) { setTimeout(r, 500); });
        } catch (err) {
          console.error('  ERROR processing call:', err.message);
          console.error('  Stack:', err.stack);
        }
      }
      console.log('Backfill complete!');
    } catch (err) {
      console.error('Backfill failed:', err.message);
      console.error('Stack:', err.stack);
    }
});

app.listen(config.server.port, function() {
    console.log('Fathom Brain running on port ' + config.server.port);
});

startSlackBot();
