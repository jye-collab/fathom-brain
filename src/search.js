import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';
import { generateEmbedding } from './embeddings.js';
import { config } from './config.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Search for relevant meeting chunks using semantic similarity.
 * Returns the most relevant pieces of your meeting history.
 */
export async function searchMeetings(query, { matchCount = 15, threshold = 0.65 } = {}) {
  // Generate embedding for the search query
  const queryEmbedding = await generateEmbedding(query);

  // Search using the Supabase function we created
  const { data: results, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: matchCount,
  });

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
  console.log(`🧠 Brain query: "${question}"`);

  // 1. Search for relevant meeting chunks
  const results = await searchMeetings(question);
  const stats = await getMeetingStats();

  if (results.length === 0) {
    return {
      answer:
        "I couldn't find anything relevant in your meeting recordings for that question. Try rephrasing, or this might be a topic that hasn't come up in your calls yet.",
      sources: [],
      meetingCount: stats.totalMeetings,
    };
  }

  // 2. Build the context from search results
  const contextChunks = results.map((r, i) => {
    const date = new Date(r.meeting_date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    return `--- Source ${i + 1} (from "${r.meeting_title}" on ${date}, relevance: ${(r.similarity * 100).toFixed(0)}%) ---\n${r.content}`;
  });

  const context = contextChunks.join('\n\n');

  // 3. Build the system prompt
  const systemPrompt = `You are Jye's personal knowledge assistant — a "second brain" built from all of Jye's meeting recordings and calls.

YOUR ROLE:
- Answer questions based ONLY on what Jye has actually said, discussed, or expressed in meetings
- Synthesize insights across multiple conversations when relevant
- Speak as if you deeply understand Jye's thinking, opinions, and business context
- If the context doesn't contain enough info, say so honestly — never make things up

YOUR KNOWLEDGE BASE:
- ${stats.totalMeetings} total meetings indexed
- You have access to relevant excerpts from these meetings below

GUIDELINES:
- Reference specific meetings/dates when possible ("In your call on Jan 15th, you mentioned...")
- When asked about opinions or preferences, quote or paraphrase what Jye actually said
- When asked to create content (lead magnets, posts, etc.), base it on actual themes and language from the meetings
- Be direct and actionable — Jye doesn't want fluff
- If asked something that's not in the meeting data, clearly state that and offer to help differently

MEETING CONTEXT:
${context}`;

  // 4. Ask Claude
  const message = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });

  const answer = message.content[0].text;

  // 5. Deduplicate sources
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

  console.log(`   ✅ Answer generated from ${results.length} chunks across ${sources.length} meetings`);

  return {
    answer,
    sources,
    meetingCount: stats.totalMeetings,
  };
}
