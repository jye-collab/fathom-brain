import 'dotenv/config';

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-5-20250929', // Latest Claude model
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    embeddingModel: 'text-embedding-3-small',
  },
  fathom: {
    apiKey: process.env.FATHOM_API_KEY,
    baseUrl: 'https://api.fathom.video/v1',
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
  webhook: {
    secret: process.env.WEBHOOK_SECRET,
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
  // Chunking settings
  chunking: {
    maxChunkTokens: 500,    // ~500 tokens per chunk
    overlapTokens: 50,       // 50 token overlap between chunks
    maxChunkChars: 2000,     // Approximate char limit per chunk
    overlapChars: 200,       // Approximate char overlap
  },
};
