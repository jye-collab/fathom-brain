import { config } from './config.js';
import { ingestMeeting } from './ingest.js';

/**
 * Backfill script — pulls ALL your existing Fathom recordings
 * and ingests them into your brain database.
 *
 * Run once: node src/backfill.js
 */

const FATHOM_BASE = 'https://api.fathom.video/v1';

async function fathomFetch(endpoint) {
  const url = `${FATHOM_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.fathom.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fathom API error (${res.status}): ${text}`);
  }

  return res.json();
}

async function getAllCalls() {
  let allCalls = [];
  let cursor = null;

  console.log('📡 Fetching all calls from Fathom...');

  while (true) {
    const params = cursor ? `?cursor=${cursor}` : '';
    const response = await fathomFetch(`/calls${params}`);

    const calls = response.calls || response.data || response;
    if (Array.isArray(calls)) {
      allCalls = allCalls.concat(calls);
    }

    console.log(`   Found ${allCalls.length} calls so far...`);

    // Check for pagination
    cursor = response.next_cursor || response.cursor;
    if (!cursor || (Array.isArray(calls) && calls.length === 0)) break;
  }

  return allCalls;
}

async function getCallTranscript(callId) {
  try {
    const response = await fathomFetch(`/calls/${callId}/transcript`);
    // Handle different response formats
    if (typeof response === 'string') return response;
    if (response.text) return response.text;
    if (response.transcript) return response.transcript;

    // If it's an array of segments, join them
    if (Array.isArray(response)) {
      return response
        .map((seg) => {
          const speaker = seg.speaker || seg.speaker_name || 'Speaker';
          const text = seg.text || seg.content || '';
          return `${speaker}: ${text}`;
        })
        .join('\n');
    }

    return JSON.stringify(response);
  } catch (error) {
    console.warn(`   ⚠️ Could not fetch transcript for call ${callId}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('🧠 FATHOM BRAIN — Backfill Script');
  console.log('==================================\n');

  if (!config.fathom.apiKey) {
    console.error('❌ FATHOM_API_KEY is not set in your .env file');
    process.exit(1);
  }

  // 1. Get all calls
  const calls = await getAllCalls();
  console.log(`\n📋 Found ${calls.length} total calls\n`);

  if (calls.length === 0) {
    console.log('No calls found. Make sure your Fathom API key is correct.');
    return;
  }

  // 2. Process each call
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const callId = call.id || call.call_id;
    const title = call.title || call.summary?.title || 'Untitled';
    const progress = `[${i + 1}/${calls.length}]`;

    console.log(`\n${progress} Processing: "${title}"`);

    // Get the transcript
    const transcript = await getCallTranscript(callId);

    if (!transcript || transcript.length < 50) {
      console.log(`   ⏭️ Skipping (no transcript or too short)`);
      skipped++;
      continue;
    }

    try {
      await ingestMeeting({
        fathomCallId: callId,
        title,
        date: call.date || call.created_at || call.started_at || new Date().toISOString(),
        durationSeconds: call.duration_seconds || call.duration || 0,
        attendees: call.attendees || call.participants || [],
        summary: call.summary?.text || call.ai_summary || '',
        transcript,
      });
      success++;
    } catch (error) {
      console.error(`   ❌ Failed: ${error.message}`);
      failed++;
    }

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n==================================');
  console.log('🏁 Backfill Complete!');
  console.log(`   ✅ Success: ${success}`);
  console.log(`   ⏭️ Skipped: ${skipped}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log('==================================');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
