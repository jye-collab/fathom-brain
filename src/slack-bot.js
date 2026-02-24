import pkg from '@slack/bolt';
const { App } = pkg;
import { queryBrain } from './search.js';
import { config } from './config.js';

/**
 * Initialize and start the Slack bot.
 * Uses Socket Mode so you don't need a public URL during development.
 */
export function startSlackBot() {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  // --- Handle direct messages ---
  app.message(async ({ message, say }) => {
    // Ignore bot messages and message edits
    if (message.subtype || message.bot_id) return;

    const question = message.text?.trim();
    if (!question) return;

    try {
      // Show typing indicator
      await say({
        text: '🧠 Searching your meeting brain...',
        thread_ts: message.ts,
      });

      // Query the brain
      const result = await queryBrain(question);

      // Format the response
      const sourcesText = result.sources
        .map((s) => {
          const date = new Date(s.date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
          return `• _${s.title}_ (${date})`;
        })
        .join('\n');

      const responseBlocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: result.answer,
          },
        },
      ];

      if (result.sources.length > 0) {
        responseBlocks.push(
          { type: 'divider' },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `📚 *Sources* (from ${result.meetingCount} total meetings):\n${sourcesText}`,
              },
            ],
          }
        );
      }

      await say({
        blocks: responseBlocks,
        text: result.answer, // Fallback for notifications
        thread_ts: message.ts,
      });
    } catch (error) {
      console.error('Error handling message:', error);
      await say({
        text: `❌ Sorry, something went wrong: ${error.message}`,
        thread_ts: message.ts,
      });
    }
  });

  // --- Handle @mentions in channels ---
  app.event('app_mention', async ({ event, say }) => {
    // Strip the bot mention from the text
    const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!question) {
      await say({
        text: "Hey! Ask me anything about your meetings. For example: _What do I think about pricing strategies?_ or _What pain points do my customers keep bringing up?_",
        thread_ts: event.ts,
      });
      return;
    }

    try {
      await say({
        text: '🧠 Searching your meeting brain...',
        thread_ts: event.ts,
      });

      const result = await queryBrain(question);

      const sourcesText = result.sources
        .map((s) => {
          const date = new Date(s.date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
          return `• _${s.title}_ (${date})`;
        })
        .join('\n');

      const responseBlocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: result.answer,
          },
        },
      ];

      if (result.sources.length > 0) {
        responseBlocks.push(
          { type: 'divider' },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `📚 *Sources* (from ${result.meetingCount} total meetings):\n${sourcesText}`,
              },
            ],
          }
        );
      }

      await say({
        blocks: responseBlocks,
        text: result.answer,
        thread_ts: event.ts,
      });
    } catch (error) {
      console.error('Error handling mention:', error);
      await say({
        text: `❌ Sorry, something went wrong: ${error.message}`,
        thread_ts: event.ts,
      });
    }
  });

  // --- Slash command: /brain ---
  app.command('/brain', async ({ command, ack, respond }) => {
    await ack();

    const question = command.text?.trim();
    if (!question) {
      await respond({
        text: "Ask me something! Example: `/brain What topics keep coming up in my sales calls?`",
        response_type: 'ephemeral',
      });
      return;
    }

    await respond({
      text: '🧠 Searching your meeting brain...',
      response_type: 'ephemeral',
    });

    try {
      const result = await queryBrain(question);

      const sourcesText = result.sources
        .map((s) => {
          const date = new Date(s.date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
          return `• _${s.title}_ (${date})`;
        })
        .join('\n');

      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Q: ${question}*\n\n${result.answer}`,
            },
          },
          { type: 'divider' },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `📚 *Sources* (${result.meetingCount} meetings indexed):\n${sourcesText}`,
              },
            ],
          },
        ],
      });
    } catch (error) {
      console.error('Error handling /brain command:', error);
      await respond({
        text: `❌ Error: ${error.message}`,
        response_type: 'ephemeral',
      });
    }
  });

  // Start the bot
  app.start().then(() => {
    console.log('⚡ Slack bot is running!');
    console.log('   - DM me to ask questions');
    console.log('   - @mention me in a channel');
    console.log('   - Use /brain <question> anywhere');
  });

  return app;
}
