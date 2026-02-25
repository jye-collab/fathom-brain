import { supabase } from './supabase.js';
import { generateEmbeddings } from './embeddings.js';
import { config } from './config.js';

export function chunkTranscript(transcript, meetingTitle, meetingDate) {
  const { maxChunkChars, overlapChars } = config.chunking;
  const contextPrefix = '[Meeting: "' + meetingTitle + '" on ' + meetingDate + ']\n\n';
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

    console.log('  Step 2: Fetching meeting ID...');
    var r2 = await supabase.from('meetings').select('id').eq('fathom_call_id', fathomCallId).single();
    if (r2.error || !r2.data) throw new Error('Fetch failed: ' + (r2.error ? r2.error.message : 'not found'));
    var meetingId = r2.data.id;
    console.log('  Step 2 done. ID: ' + meetingId);

    console.log('  Step 3: Storing transcript (' + transcript.length + ' chars)...');
    var r3 = await supabase.from('meetings').update({ full_transcript: transcript }).eq('id', meetingId);
    if (r3.error) console.log('  Step 3 warning: ' + r3.error.message);
    else console.log('  Step 3 done.');

    console.log('  Step 4: Deleting old chunks...');
    await supabase.from('chunks').delete().eq('meeting_id', meetingId);
    console.log('  Step 4 done.');

    console.log('  Step 5: Chunking transcript...');
    var dateStr = new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    var chunks = chunkTranscript(transcript, title, dateStr);
    console.log('  Step 5 done. ' + chunks.length + ' chunks');

    console.log('  Step 6: Generating embeddings...');
    var batchSize = 20;
    var allChunkRecords = [];
    for (var i = 0; i < chunks.length; i += batchSize) {
      var batch = chunks.slice(i, i + batchSize);
      var texts = batch.map(function(c) { return c.content; });
      var batchNum = Math.floor(i / batchSize) + 1;
      var totalBatches = Math.ceil(chunks.length / batchSize);
      console.log('    Embedding batch ' + batchNum + '/' + totalBatches + '...');
      var embeddings = await generateEmbeddings(texts);
      for (var j = 0; j < batch.length; j++) {
        allChunkRecords.push({
          meeting_id: meetingId,
          chunk_index: batch[j].index,
          content: batch[j].content,
          token_count: Math.ceil(batch[j].content.length / 4),
          embedding: embeddings[j],
        });
      }
    }
    console.log('  Step 6 done.');

    console.log('  Step 7: Inserting ' + allChunkRecords.length + ' chunks...');
    for (var k = 0; k < allChunkRecords.length; k += 10) {
      var insertBatch = allChunkRecords.slice(k, k + 10);
      var r7 = await supabase.from('chunks').insert(insertBatch);
      if (r7.error) throw new Error('Insert chunks failed: ' + r7.error.message);
    }
    console.log('  Step 7 done.');

    console.log('  COMPLETE: ' + chunks.length + ' chunks stored for ' + title);
    return { id: meetingId };
  } catch (err) {
    console.error('  INGEST ERROR: ' + err.message);
    console.error('  Stack: ' + err.stack);
    throw err;
  }
}
