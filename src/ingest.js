import { supabase } from './supabase.js';
import { generateEmbedding } from './embeddings.js';
import { config } from './config.js';

export function chunkTranscript(transcript, meetingTitle, meetingDate) {
  var maxChunkChars = config.chunking.maxChunkChars;
  var overlapChars = config.chunking.overlapChars;
  var contextPrefix = '[Meeting: "' + meetingTitle + '" on ' + meetingDate + ']\n\n';
  var chunks = [];
  var start = 0;

  while (start < transcript.length) {
    var end = start + maxChunkChars;
    if (end < transcript.length) {
      var lastPeriod = transcript.lastIndexOf('. ', end);
      var lastNewline = transcript.lastIndexOf('\n', end);
      var breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChunkChars * 0.5) {
        end = breakPoint + 1;
      }
    } else {
      end = transcript.length;
    }

    var chunkText = contextPrefix + transcript.slice(start, end).trim();
    if (chunkText.length > contextPrefix.length + 10) {
      chunks.push({ content: chunkText, index: chunks.length });
    }

    start = end - overlapChars;
    if (start >= transcript.length) break;
  }

  return chunks;
}

export async function ingestMeeting({
  fathomCallId,
  title,
  date,
  durationSeconds,
  attendees = [],
  summary = '',
  transcript,
}) {
  console.log('Ingesting meeting: ' + title + ' (' + (fathomCallId || 'manual') + ')');

  try {
    // Step 1: Upsert meeting (without transcript to save memory)
    console.log('  Step 1: Upserting meeting metadata...');
    var r1 = await supabase.from('meetings').upsert({
      fathom_call_id: fathomCallId,
      title: title,
      date: date,
      duration_seconds: durationSeconds,
      attendees: attendees,
      summary: summary,
      full_transcript: '',
    }, { onConflict: 'fathom_call_id' });
    if (r1.error) throw new Error('Upsert failed: ' + r1.error.message);
    console.log('  Step 1 done.');

    // Step 2: Get meeting ID
    console.log('  Step 2: Fetching meeting ID...');
    var r2 = await supabase.from('meetings').select('id').eq('fathom_call_id', fathomCallId).single();
    if (r2.error || !r2.data) throw new Error('Fetch failed: ' + (r2.error ? r2.error.message : 'not found'));
    var meetingId = r2.data.id;
    console.log('  Step 2 done. ID: ' + meetingId);

    // Step 3: Store transcript
    console.log('  Step 3: Storing transcript (' + transcript.length + ' chars)...');
    var r3 = await supabase.from('meetings').update({ full_transcript: transcript }).eq('id', meetingId);
    if (r3.error) console.log('  Step 3 warning: ' + r3.error.message);
    else console.log('  Step 3 done.');

    // Step 4: Delete old chunks
    console.log('  Step 4: Deleting old chunks...');
    await supabase.from('chunks').delete().eq('meeting_id', meetingId);
    console.log('  Step 4 done.');

    // Step 5: Chunk transcript
    console.log('  Step 5: Chunking transcript...');
    var dateStr = new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    var chunks = chunkTranscript(transcript, title, dateStr);
    console.log('  Step 5 done. ' + chunks.length + ' chunks');

    // Step 6: Embed and insert ONE AT A TIME to avoid OOM
    console.log('  Step 6: Embedding + inserting chunks one by one...');
    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      console.log('    Chunk ' + (i + 1) + '/' + chunks.length + '...');

      // Embed single chunk
      var embedding = await generateEmbedding(chunk.content);

      // Insert immediately (don't accumulate in memory)
      var r6 = await supabase.from('chunks').insert({
        meeting_id: meetingId,
        chunk_index: chunk.index,
        content: chunk.content,
        token_count: Math.ceil(chunk.content.length / 4),
        embedding: embedding,
      });
      if (r6.error) throw new Error('Insert chunk ' + i + ' failed: ' + r6.error.message);

      // Let GC breathe
      embedding = null;
    }
    console.log('  Step 6 done.');

    console.log('  COMPLETE: ' + chunks.length + ' chunks stored for ' + title);
    return { id: meetingId };
  } catch (err) {
    console.error('  INGEST ERROR: ' + err.message);
    console.error('  Stack: ' + err.stack);
    throw err;
  }
}
