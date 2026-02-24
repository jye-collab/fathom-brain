import OpenAI from 'openai';
import { config } from './config.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Generate an embedding vector for a piece of text.
 * Uses OpenAI's text-embedding-3-small (1536 dimensions, very cheap).
 * Cost: ~$0.02 per 1M tokens — pennies for your entire meeting history.
 */
export async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: text,
  });
  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts in batch.
 */
export async function generateEmbeddings(texts) {
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}
