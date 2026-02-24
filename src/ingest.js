import { supabase } from './supabase.js';
import { generateEmbeddings } from './embeddings.js';
import { config } from './config.js';

/**
 * Split a transcript into overlapping chunks for better retrieval.
 * Each chunk includes speaker context so Claude knows who said what.
 */
export function chunkTranscript(transcript, meetingTitle, meetingDate) {
  const { maxChunkChars, overlapChars } = config.chunking;

  // Add meeting context as a prefix to help with retrieval
  const contextPrefix = `[Meeting: "${meetingTitle}" on ${meetingDate}]\n\n`;

  const chunks = [];
  let start = 0;

  while (start < transcript.length) {
    let end = start + maxChunkChars;

    // Try to break at a sentence boundary
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
      chunks.push({
        content: chunkText,
        index: chunks.length,
      });
    }

    start = end - overlapChars;
    if (start >= transcript.length) break;
  }

  return chunks;
}

/**
 * Ingest a single meeting transcript into the database.
 * - Stores meeting metadata
 * - Chunks the transcript
 * - Generates embeddings for each chunk
 * - Stores everything in Supabase
 *
 * Returns the meeting record.
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
  console.log(`📥 Ingesting meeting: "${title}" (${fathomCallId || 'manual'})`);

  // 1. Upsert the meeting record
  const { data: meeting, error: meetingError } = await supabase
    .from('meetings')
    .upsert(
      {
        fathom_call_id: fathomCallId,
        title,
        date,
        duration_seconds: durationSeconds,
        attendees,
        summary,
        full_transcript: transcript,
      },
      { onConflict: 'fathom_call_id' }
    )
    .select()
    .single();

  if (meetingError) {
    throw new Error(`Failed to upsert meeting: ${meetingError.message}`);
  }

  // 2. Delete any existing chunks for this meeting (for re-ingestion)
  await supabase.from('chunks').delete().eq('meeting_id', meeting.id);

  // 3. Chunk the transcript
  const dateStr = new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const chunks = chunkTranscript(transcript, title, dateStr);
  console.log(`   📝 Split into ${chunks.length} chunks`);

  // 4. Generate embeddings in batches of 20
  const batchSize = 20;
  const allChunkRecords = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.content);
    const embeddings = await generateEmbeddings(texts);

    for (let j = 0; j < batch.length; j++) {
      allChunkRecords.push({
        meeting_id: meeting.id,
        chunk_index: batch[j].index,
        content: batch[j].content,
        token_count: Math.ceil(batch[j].content.length / 4), // rough estimate
        embedding: embeddings[j],
      });
    }

    console.log(`   🧠 Embedded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}`);
  }

  // 5. Insert all chunks
  const { error: chunksError } = await supabase
    .from('chunks')
    .insert(allChunkRecords);

  if (chunksError) {
    throw new Error(`Failed to insert chunks: ${chunksError.message}`);
  }

  console.log(`   ✅ Done! ${chunks.length} chunks stored for "${title}"`);
  return meeting;
}
