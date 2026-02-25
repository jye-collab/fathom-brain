import { supabase } from './supabase.js';
import { generateEmbeddings } from './embeddings.js';
import { config } from './config.js';

/**
 * Split a transcript into overlapping chunks for better retrieval.
 */
export function chunkTranscript(transcript, meetingTitle, meetingDate) {
  const { maxChunkChars, overlapChars } = config.chunking;
  const contextPrefix = `[Meeting: "${meetingTitle}" on ${meetingDate}]\n\n`;
  const chunks = [];
  let start = 0;

  while (start < transcript.length) {
    let end = start + maxChunkChars;
    if (end < transcript.length) {
      const lastPeriod = transcript.lastIndexOf('. ', end);
      const lastNewline = transcript.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChunkChars * 0.5) {
        end = breakPoint + 1;
      }
    } else {
      end = transcript.length;
    }

    const chunkText = contextPrefix + transcript.slice(start, end).trim();
    if (chunkText.length > contextPrefix.length + 10) {
      chunks.push({ content: chunkText, index: chunks.length });
    }

    start = end - overlapChars;
    if (start >= transcript.length) break;
  }

  return chunks;
}

/**
 * Helper: wrap a promise with a timeout
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

/**
 * Ingest a single meeting transcript into the database.
 */
export async function ingestMeeting({
  fathomCallId,
  title,
  date,
  durationSeconds,
  attendees = [],
  summary = '',
  transcript,
}) {
  console.log(`Ingesting meeting: "${title}" (${fathomCallId || 'manual'})`);

  // 1. Upsert meeting record WITHOUT full_transcript first (small payload)
  console.log('  Step 1: Upserting meeting metadata...');
  const { error: upsertError } = await withTimeout(
    supabase
      .from('meetings')
      .upsert(
        {
          fathom_call_id: fathomCallId,
          title,
          date,
          duration_seconds: durationSeconds,
          attendees,
          summary,
          full_transcript: '',
        },
        { onConflict: 'fathom_call_id' }
      ),
    15000,
    'upsert meeting'
  );

  if (upsertError) {
    throw new Error(`Failed to upsert meeting: ${upsertError.message}`);
  }
  console.log('  Step 1 done.');

  // 2. Fetch the meeting ID
  console.log('  Step 2: Fetching meeting ID...');
  const { data: meeting, error: fetchError } = await withTimeout(
    supabase
      .from('meetings')
      .select('id')
      .eq('fathom_call_id', fathomCallId)
      .single(),
    10000,
    'fetch meeting'
  );

  if (fetchError || !meeting) {
    throw new Error(`Failed to fetch meeting: ${fetchError ? fetchError.message : 'not found'}`);
  }
  console.log(`  Step 2 done. Meeting ID: ${meeting.id}`);

  // 3. Update transcript separately (large payload, no .select())
  console.log(`  Step 3: Storing transcript (${transcript.length} chars)...`);
  const { error: txError } = await withTimeout(
    supabase
      .from('meetings')
      .update({ full_transcript: transcript })
      .eq('id', meeting.id),
    30000,
    'update transcript'
  );

  if (txError) {
    console.error(`  Warning: transcript storage failed: ${txError.message}`);
    // Continue anyway - chunks are what matter for RAG
  } else {
    console.log('  Step 3 done.');
  }

  // 4. Delete existing chunks
  console.log('  Step 4: Deleting old chunks...');
  await withTimeout(
    supabase.from('chunks').delete().eq('meeting_id', meeting.id),
    10000,
    'delete chunks'
  );
  console.log('  Step 4 done.');

  // 5. Chunk the transcript
  const dateStr = new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const chunks = chunkTranscript(transcript, title, dateStr);
  console.log(`  Step 5: Split into ${chunks.length} chunks`);

  // 6. Generate embeddings in batches of 20
  const batchSize = 20;
  const allChunkRecords = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.content);

    console.log(`  Step 6: Embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}...`);
    const embeddings = await withTimeout(
      generateEmbeddings(texts),
      60000,
      `embed batch ${Math.floor(i / batchSize) + 1}`
    );

    for (let j = 0; j < batch.length; j++) {
      allChunkRecords.push({
        meeting_id: meeting.id,
        chunk_index: batch[j].index,
        content: batch[j].content,
        token_count: Math.ceil(batch[j].content.length / 4),
        embedding: embeddings[j],
      });
    }
  }

  // 7. Insert chunks in batches to avoid huge payloads
  console.log(`  Step 7: Inserting ${allChunkRecords.length} chunks...`);
  const insertBatch = 10;
  for (let i = 0; i < allChunkRecords.length; i += insertBatch) {
    const batch = allChunkRecords.slice(i, i + insertBatch);
    const { error: chunksError } = await withTimeout(
      supabase.from('chunks').insert(batch),
      30000,
      `insert chunks batch ${Math.floor(i / insertBatch) + 1}`
    );

    if (chunksError) {
      throw new Error(`Failed to insert chunks batch: ${chunksError.message}`);
    }
  }

  console.log(`  Done! ${chunks.length} chunks stored for "${title}"`);
  return meeting;
}
