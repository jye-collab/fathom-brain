import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';
import { generateEmbedding } from './embeddings.js';
import { config } from './config.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Search for relevant meeting chunks using semantic similarity.
 * Returns the most relevant pieces of your meeting history.
 */
export async function searchMeetings(query, { matchCount = 15, threshold = 0.3 } = {}) {
    // Generate embedding for the search query
  console.log('  [search] generating embedding for query...');
    const queryEmbedding = await generateEmbedding(query);
    console.log('  [search] embedding generated, dims=' + (queryEmbedding ? queryEmbedding.length : 'null') + ' type=' + typeof queryEmbedding);

  // Convert to string format for pgvector if needed
  const embeddingStr = '[' + queryEmbedding.join(',') + ']';

  // Search using the Supabase function we created
  console.log('  [search] calling match_chunks RPC with threshold=' + threshold + ' matchCount=' + matchCount);
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
      .select(
