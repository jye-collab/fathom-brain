import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';
import { generateEmbedding } from './embeddings.js';
import { config } from './config.js';
import { buildSoulPrompt } from './soul.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Search for relevant meeting chunks using semantic similarity.
 * Returns the most relevant pieces of your meeting history.
 */
export async function searchMeetings(query, { matchCount = 15, threshold = 0.3 } = {}) {
  // Generate embedding for the search query
  console.log('  [search] generating embedding for query...');
  const queryEmbedding = await generateEmbedding(query);
  console.log('  [search] embedding generated, dims=' + (queryEmbedding ? queryEmbedding.length : 'null'));

  // Convert to string format for pgvector
  const embeddingStr = '[' + queryEmbedding.join(',') + ']';

  // Search using the Supabase function we created
  console.log('  [search] calling match_chunks RPC...');
  const { data: results, error } = await supabase.rpc('match_chunks', {
    query_embedding: embeddingStr,
    match_threshold: threshold,
    match_count: matchCount,
  });

  console.log('  [search] RPC returned: error=' + JSON.stringify(error) + ' results=' + (results ? results.length : 'null'));

  if (error) {
    throw new Error(`Search failed: ${error.message}`);
  }

  return results || [];
}

/**
 * Get total meeting stats for context.
 */
async function getMeetingStats() {
  const { count } = await supabase
    .from('meetings')
    .select('*', { count: 'exact', head: true });

  const { data: recent } = await supabase
    .from('meetings')
    .select('title, date')
    .order('date', { ascending: false })
    .limit(5);

  return { totalMeetings: count || 0, recentMeetings: recent || [] };
}

/**
 * The main brain query function.
 * Takes a question, searches your meetings, and asks Claude to answer
 * based ONLY on what you've actually said in your meetings.
 */
export async function queryBrain(question) {
  console.log('Brain query: "' + question + '"');

  // 1. Search for relevant meeting chunks
  const results = await searchMeetings(question);
  const stats = await getMeetingStats();

  if (results.length === 0) {
    return {
      answer:
        "Couldn't find anything relevant in your meeting recordings for that question. Try rephrasing, or this might be a topic that hasn't come up in your calls yet.",
      sources: [],
      meetingCount: stats.totalMeetings,
    };
  }

  // 2. Build the context from search results
  const contextChunks = results.map((r, i) => {
    const date = new Date(r.meeting_date).toLocaleDateString('en-AU', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    return '--- Source ' + (i + 1) + ' (from "' + r.meeting_title + '" on ' + date + ', relevance: ' + (r.similarity * 100).toFixed(0) + '%) ---\n' + r.content;
  });

  const context = contextChunks.join('\n\n');

  // 3. Load the soul (base identity + brain context + dynamic learnings)
  const soul = await buildSoulPrompt();

  // 4. Build the system prompt with soul + meeting context
  const systemPrompt = `${soul}

# Current Query Context

KNOWLEDGE BASE: ${stats.totalMeetings} total meetings indexed.

RELEVANT MEETING EXCERPTS:
${context}

RESPONSE FORMAT:
- Use Slack-compatible formatting: *bold* for emphasis (not **bold**), _italic_ for meeting titles
- Use bullet points with • or -
- Do NOT use markdown headers (## or ###) — use *bold text* on its own line instead
- Keep responses focused and under 2500 characters when possible
- Reference specific meetings and dates
- If the context doesn't contain enough info, say so honestly — never fabricate`;

  // 5. Ask Claude
  const message = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });

  const answer = message.content[0].text;

  // 6. Deduplicate sources
  const sourceMap = new Map();
  for (const r of results) {
    if (!sourceMap.has(r.meeting_id)) {
      sourceMap.set(r.meeting_id, {
        title: r.meeting_title,
        date: r.meeting_date,
        similarity: r.similarity,
      });
    }
  }

  const sources = Array.from(sourceMap.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  console.log('Answer generated from ' + results.length + ' chunks across ' + sources.length + ' meetings');

  return {
    answer,
    sources,
    meetingCount: stats.totalMeetings,
  };
}
