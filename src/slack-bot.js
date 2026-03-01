import pkg from '@slack/bolt';
const { App } = pkg;
import { queryBrain } from './search.js';
import { config } from './config.js';

/**
 * Convert Claude's markdown to Slack mrkdwn format.
 * Handles common incompatibilities that cause invalid_blocks errors.
 */
function toSlackMrkdwn(text) {
  let result = text;

  // Convert markdown headers to bold text (## Header → *Header*)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Convert **bold** to *bold* (Slack uses single asterisks)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert ``` code blocks to simple indented text
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    return code.split('\n').map(line => '> ' + line).join('\n');
  });

  // Remove any remaining triple backticks
  result = result.replace(/```/g, '');

  return result;
}

/**
 * Split a long message into chunks that fit within Slack's 3000 char section limit.
 * Splits at paragraph boundaries to keep content readable.
 */
function splitIntoBlocks(text, maxLen = 2900) {
  if (text.length <= maxLen) {
    return [text];
  }

  const blocks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      blocks.push(remaining);
      break;
    }

    // Find a good split point — try double newline (paragraph break) first
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.3) {
      // If no good paragraph break, try single newline
      splitAt = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // Last resort: split at maxLen
      splitAt = maxLen;
    }

    blocks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return blocks;
}

/**
 * Build Slack Block Kit blocks from a brain query result.
 * Handles long responses by splitting into multiple section blocks.
 */
function buildResponseBlocks(result) {
  const slackText = toSlackMrkdwn(result.answer);
  const textChunks = splitIntoBlocks(slackText);

  const responseBlocks = textChunks.map(chunk => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: chunk,
    },
  }));

  if (result.sources.length > 0) {
    const sourcesText = result.sources
      .map((s) => {
        const date = new Date(s.date).toLocaleDateString('en-AU', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
        return `• _${s.title}_ (${date})`;
      })
      .join('\n');

    // Ensure sources text fits in context block (max 3000 chars)
    const sourcesContent = `📚 *Sources* (from ${result.meetingCount} total meetings):\n${sourcesText}`;

    responseBlocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: sourcesContent.slice(0, 3000),
          },
        ],
      }
    );
  }

  return responseBlocks;
}

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
        text: '🧠 Thinking...',
        thread_ts: message.ts,
      });

      // Query the brain
      const result = await queryBrain(question);

      // Build and send response blocks
      const responseBlocks = buildResponseBlocks(result);

      await say({
        blocks: responseBlocks,
        text: result.answer.slice(0, 500), // Fallback for notifications (short)
        thread_ts: message.ts,
      });
    } catch (error) {
      console.error('Error handling message:', error);
      const errMsg = error.message || 'Unknown error';
      await say({
        text: `❌ Something went wrong: ${errMsg.slice(0, 200)}`,
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
        text: "Ask me anything about your meetings — like _What pain points do clients keep bringing up?_ or _What did I discuss with [name] last week?_",
        thread_ts: event.ts,
      });
      return;
    }

    try {
      await say({
        text: '🧠 Thinking...',
        thread_ts: event.ts,
      });

      const result = await queryBrain(question);
      const responseBlocks = buildResponseBlocks(result);

      await say({
        blocks: responseBlocks,
        text: result.answer.slice(0, 500),
        thread_ts: event.ts,
      });
    } catch (error) {
      console.error('Error handling mention:', error);
      await say({
        text: `❌ Something went wrong: ${(error.message || '').slice(0, 200)}`,
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
      text: '🧠 Thinking...',
      response_type: 'ephemeral',
    });

    try {
      const result = await queryBrain(question);
      const responseBlocks = buildResponseBlocks(result);

      // Prepend the question to the first block
      if (responseBlocks.length > 0 && responseBlocks[0].type === 'section') {
        responseBlocks[0].text.text = `*Q: ${question}*\n\n${responseBlocks[0].text.text}`;
        // Re-check length after prepending
        if (responseBlocks[0].text.text.length > 3000) {
          const overflow = responseBlocks[0].text.text;
          responseBlocks[0].text.text = overflow.slice(0, 2900);
          responseBlocks.splice(1, 0, {
            type: 'section',
            text: { type: 'mrkdwn', text: overflow.slice(2900) },
          });
        }
      }

      await respond({
        response_type: 'ephemeral',
        blocks: responseBlocks,
      });
    } catch (error) {
      console.error('Error handling /brain command:', error);
      await respond({
        text: `❌ Error: ${(error.message || '').slice(0, 200)}`,
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
