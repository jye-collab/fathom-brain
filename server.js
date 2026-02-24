import express from 'express';
import { startSlackBot } from './src/slack-bot.js';
import { createWebhookRouter } from './src/webhook.js';
import { config } from './src/config.js';

const app = express();

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Mount webhook routes
app.use('/webhook', createWebhookRouter());

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Fathom Brain',
    status: 'running',
    endpoints: {
      webhook: '/webhook/fathom',
      health: '/webhook/health',
    },
  });
});

// Start Express server (for webhooks)
app.listen(config.server.port, () => {
  console.log(`\n🧠 Fathom Brain server running on port ${config.server.port}`);
  console.log(`   Webhook URL: http://localhost:${config.server.port}/webhook/fathom`);
  console.log(`   Health check: http://localhost:${config.server.port}/webhook/health\n`);
});

// Start the Slack bot (socket mode)
startSlackBot();
