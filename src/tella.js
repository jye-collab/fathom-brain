import { supabase } from './supabase.js';
import { generateEmbedding } from './embeddings.js';
import { config } from './config.js';
import { chunkTranscript } from './ingest.js';

var TELLA_BASE = 'https://api.tella.com/v1';

function tellaHeaders() {
  var key = config.tella.apiKey;
  if (!key) throw new Error('TELLA_API_KEY not set');
  return {
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch all videos from Tella with pagination.
 * Returns array of video objects with transcripts.
 */
async function fetchAllTellaVideos() {
  var allVideos = [];
  var cursor = null;
  var page = 1;

  while (true) {
    var url = TELLA_BASE + '/videos?limit=50';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);

    console.log('[tella] Fetching page ' + page + '...');
    var res = await fetch(url, {
      headers: tellaHeaders(),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      var errText = await res.text();
      throw new Error('Tella API ' + res.status + ': ' + errText.slice(0, 200));
    }

    var data = await res.json();
    var videos = data.data || data.videos || data.items || data || [];
    if (!Array.isArray(videos)) videos = [];

    if (videos.length === 0) break;

    allVideos = allVideos.concat(videos);
    console.log('[tella] Got ' + videos.length + ' videos (total: ' + allVideos.length + ')');

    cursor = data.cursor || data.next_cursor || data.nextCursor || null;
    if (!cursor) break;
    page++;
  }

  return allVideos;
}

/**
 * Fetch a single video's full details (including transcript).
 */
async function fetchTellaVideo(videoId) {
  var res = await fetch(TELLA_BASE + '/videos/' + videoId, {
    headers: tellaHeaders(),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Tella video ' + videoId + ' fetch failed ' + res.status + ': ' + errText.slice(0, 200));
  }

  return await res.json();
}

/**
 * Extract transcript text from a Tella video object.
 * Handles both sentence-level and full text formats.
 */
function extractTranscript(video) {
  var tx = video.transcript;
  if (!tx) {
    console.log('[tella] No transcript field on video');
    return '';
  }

  // If transcript is just a string, use it directly
  if (typeof tx === 'string') return tx;

  if (tx.status && tx.status !== 'ready') {
    console.log('[tella] Transcript status: ' + tx.status);
    return '';
  }

  // If sentences array exists, join them for a clean transcript
  if (tx.sentences && Array.isArray(tx.sentences) && tx.sentences.length > 0) {
    return tx.sentences.map(function (s) { return s.text || ''; }).join(' ');
  }

  // Try segments (another common format)
  if (tx.segments && Array.isArray(tx.segments) && tx.segments.length > 0) {
    return tx.segments.map(function (s) { return s.text || s.content || ''; }).join(' ');
  }

  // Fall back to full text field
  if (tx.text && typeof tx.text === 'string') return tx.text;

  // Fall back to content field
  if (tx.content && typeof tx.content === 'string') return tx.content;

  // Last resort â stringify whatever we got
  console.log('[tella] Unknown transcript format, keys: ' + Object.keys(tx).join(', '));
  return '';
}

/**
 * Ingest a single Tella video into Supabase.
 * Uses tella_{videoId} as the fathom_call_id for compatibility
 * with the existing meetings/chunks schema.
 */
async function ingestTellaVideo(video) {
  var videoId = video.id;
  var callId = 'tella_' + videoId;
  var title = video.title || video.name || 'Untitled Tella Video';
  var date = video.createdAt || video.created_at || new Date().toISOString();
  var duration = video.duration || video.durationSeconds || video.duration_seconds || 0;

  // Get full video details with transcript
  var fullVideo = await fetchTellaVideo(videoId);
  var transcript = extractTranscript(fullVideo);
  fullVideo = null; // free memory

  if (transcript.length < 50) {
    console.log('[tella] Skip "' + title + '" â transcript too short (' + transcript.length + ' chars)');
    return { skipped: true };
  }

  console.log('[tella] Ingesting "' + title + '" (' + transcript.length + ' chars)');

  // Upsert meeting record (source: tella)
  var r1 = await supabase.from('meetings').upsert({
    fathom_call_id: callId,
    title: '[Tella] ' + title,
    date: date,
    duration_seconds: duration,
    attendees: [],
    summary: video.description || '',
    full_transcript: transcript,
  }, { onConflict: 'fathom_call_id' });
  if (r1.error) throw new Error('Upsert: ' + r1.error.message);

  // Get meeting ID
  var r2 = await supabase.from('meetings').select('id').eq('fathom_call_id', callId).single();
  if (r2.error) throw new Error('Select: ' + r2.error.message);
  var meetingId = r2.data.id;

  // Delete old chunks for this video
  await supabase.from('chunks').delete().eq('meeting_id', meetingId);

  // Chunk transcript with [Tella Training] prefix
  var dateStr = new Date(date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  var chunks = chunkTranscript(transcript, '[Tella] ' + title, dateStr);
  transcript = null; // free memory

  console.log('[tella] Embedding ' + chunks.length + ' chunks...');

  // Embed and insert one at a time
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    var embedding = await generateEmbedding(chunk.content);

    var ri = await supabase.from('chunks').insert({
      meeting_id: meetingId,
      chunk_index: chunk.index,
      content: chunk.content,
      token_count: Math.ceil(chunk.content.length / 4),
      embedding: embedding,
    });
    if (ri.error) throw new Error('Chunk ' + i + ': ' + ri.error.message);

    embedding = null;
  }

  console.log('[tella] Done â ' + chunks.length + ' chunks for "' + title + '"');
  return { id: meetingId, chunks: chunks.length };
}

/**
 * Main Tella ingestion function.
 * Fetches all videos, skips already-ingested ones, ingests new ones.
 */
export async function ingestTella() {
  console.log('[tella] === Starting Tella ingestion ===');

  if (!config.tella.apiKey) {
    console.log('[tella] No TELLA_API_KEY set â skipping');
    return { ok: 0, skip: 0, fail: 0, total: 0 };
  }

  // Get already-ingested Tella video IDs
  var { data: existing } = await supabase
    .from('meetings')
    .select('fathom_call_id')
    .like('fathom_call_id', 'tella_%');

  var existingIds = new Set((existing || []).map(function (r) { return r.fathom_call_id; }));
  console.log('[tella] Already ingested: ' + existingIds.size + ' videos');

  // Fetch all videos from Tella
  var videos = await fetchAllTellaVideos();
  console.log('[tella] Found ' + videos.length + ' total videos in Tella');

  var ok = 0, skip = 0, fail = 0;

  for (var i = 0; i < videos.length; i++) {
    var video = videos[i];
    var callId = 'tella_' + video.id;

    // Skip already-ingested
    if (existingIds.has(callId)) {
      skip++;
      continue;
    }

    try {
      var result = await ingestTellaVideo(video);
      if (result.skipped) {
        skip++;
      } else {
        ok++;
      }

      // Rate limiting â small delay between videos
      await new Promise(function (r) { setTimeout(r, 500); });
    } catch (err) {
      fail++;
      console.error('[tella] Error on "' + (video.name || video.id) + '": ' + err.message);
    }
  }

  console.log('[tella] === Done === ok=' + ok + ' skip=' + skip + ' fail=' + fail + ' total=' + videos.length);
  return { ok: ok, skip: skip, fail: fail, total: videos.length };
}
import { supabase } from './supabase.js';
import { generateEmbedding } from './embeddings.js';
import { config } from './config.js';
import { chunkTranscript } from './ingest.js';

var TELLA_BASE = 'https://api.tella.com/v1';

function tellaHeaders() {
  var key = config.tella.apiKey;
  if (!key) throw new Error('TELLA_API_KEY not set');
  return {
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch all videos from Tella with pagination.
 * Returns array of video objects with transcripts.
 */
async function fetchAllTellaVideos() {
  var allVideos = [];
  var cursor = null;
  var page = 1;

  while (true) {
    var url = TELLA_BASE + '/videos?limit=50';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);

    console.log('[tella] Fetching page ' + page + '...');
    var res = await fetch(url, {
      headers: tellaHeaders(),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      var errText = await res.text();
      throw new Error('Tella API ' + res.status + ': ' + errText.slice(0, 200));
    }

    var data = await res.json();
    var videos = data.data || data.videos || data.items || data || [];
    if (!Array.isArray(videos)) videos = [];

    if (videos.length === 0) break;

    allVideos = allVideos.concat(videos);
    console.log('[tella] Got ' + videos.length + ' videos (total: ' + allVideos.length + ')');

    cursor = data.cursor || data.next_cursor || data.nextCursor || null;
    if (!cursor) break;
    page++;
  }

  return allVideos;
}

/**
 * Fetch a single video's full details (including transcript).
 */
async function fetchTellaVideo(videoId) {
  var res = await fetch(TELLA_BASE + '/videos/' + videoId, {
    headers: tellaHeaders(),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Tella video ' + videoId + ' fetch failed ' + res.status + ': ' + errText.slice(0, 200));
  }

  return await res.json();
}

/**
 * Extract transcript text from a Tella video object.
 * Handles both sentence-level and full text formats.
 */
function extractTranscript(video) {
  var tx = video.transcript;
  if (!tx) return '';
  if (tx.status && tx.status !== 'ready') return '';

  // If sentences array exists, join them for a clean transcript
  if (tx.sentences && Array.isArray(tx.sentences) && tx.sentences.length > 0) {
    return tx.sentences.map(function (s) { return s.text || ''; }).join(' ');
  }

  // Fall back to full text field
  if (tx.text && typeof tx.text === 'string') return tx.text;

  return '';
}

/**
 * Ingest a single Tella video into Supabase.
 * Uses tella_{videoId} as the fathom_call_id for compatibility
 * with the existing meetings/chunks schema.
 */
async function ingestTellaVideo(video) {
  var videoId = video.id;
  var callId = 'tella_' + videoId;
  var title = video.name || 'Untitled Tella Video';
  var date = video.createdAt || video.created_at || new Date().toISOString();
  var duration = video.durationSeconds || video.duration_seconds || 0;

  // Get full video details with transcript
  var fullVideo = await fetchTellaVideo(videoId);
  var transcript = extractTranscript(fullVideo);
  fullVideo = null; // free memory

  if (transcript.length < 50) {
    console.log('[tella] Skip "' + title + '" — transcript too short (' + transcript.length + ' chars)');
    return { skipped: true };
  }

  console.log('[tella] Ingesting "' + title + '" (' + transcript.length + ' chars)');

  // Upsert meeting record (source: tella)
  var r1 = await supabase.from('meetings').upsert({
    fathom_call_id: callId,
    title: '[Tella] ' + title,
    date: date,
    duration_seconds: duration,
    attendees: [],
    summary: video.description || '',
    full_transcript: transcript,
  }, { onConflict: 'fathom_call_id' });
  if (r1.error) throw new Error('Upsert: ' + r1.error.message);

  // Get meeting ID
  var r2 = await supabase.from('meetings').select('id').eq('fathom_call_id', callId).single();
  if (r2.error) throw new Error('Select: ' + r2.error.message);
  var meetingId = r2.data.id;

  // Delete old chunks for this video
  await supabase.from('chunks').delete().eq('meeting_id', meetingId);

  // Chunk transcript with [Tella] prefix
  var dateStr = new Date(date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  var chunks = chunkTranscript(transcript, '[Tella] ' + title, dateStr);
  transcript = null; // free memory

  console.log('[tella] Embedding ' + chunks.length + ' chunks...');

  // Embed and insert one at a time
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    var embedding = await generateEmbedding(chunk.content);

    var ri = await supabase.from('chunks').insert({
      meeting_id: meetingId,
      chunk_index: chunk.index,
      content: chunk.content,
      token_count: Math.ceil(chunk.content.length / 4),
      embedding: embedding,
    });
    if (ri.error) throw new Error('Chunk ' + i + ': ' + ri.error.message);

    embedding = null;
  }

  console.log('[tella] Done — ' + chunks.length + ' chunks for "' + title + '"');
  return { id: meetingId, chunks: chunks.length };
}

/**
 * Main Tella ingestion function.
 * Fetches all videos, skips already-ingested ones, ingests new ones.
 */
export async function ingestTella() {
  console.log('[tella] === Starting Tella ingestion ===');

  if (!config.tella.apiKey) {
    console.log('[tella] No TELLA_API_KEY set — skipping');
    return { ok: 0, skip: 0, fail: 0, total: 0 };
  }

  // Get already-ingested Tella video IDs
  var { data: existing } = await supabase
    .from('meetings')
    .select('fathom_call_id')
    .like('fathom_call_id', 'tella_%');

  var existingIds = new Set((existing || []).map(function (r) { return r.fathom_call_id; }));
  console.log('[tella] Already ingested: ' + existingIds.size + ' videos');

  // Fetch all videos from Tella
  var videos = await fetchAllTellaVideos();
  console.log('[tella] Found ' + videos.length + ' total videos in Tella');

  var ok = 0, skip = 0, fail = 0;

  for (var i = 0; i < videos.length; i++) {
    var video = videos[i];
    var callId = 'tella_' + video.id;

    // Skip already-ingested
    if (existingIds.has(callId)) {
      skip++;
      continue;
    }

    try {
      var result = await ingestTellaVideo(video);
      if (result.skipped) {
        skip++;
      } else {
        ok++;
      }

      // Rate limiting — small delay between videos
      await new Promise(function (r) { setTimeout(r, 500); });
    } catch (err) {
      fail++;
      console.error('[tella] Error on "' + (video.name || video.id) + '": ' + err.message);
    }
  }

  console.log('[tella] === Done === ok=' + ok + ' skip=' + skip + ' fail=' + fail + ' total=' + videos.length);
  return { ok: ok, skip: skip, fail: fail, total: videos.length };
}
