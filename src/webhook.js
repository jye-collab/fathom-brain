import express from 'express';
import crypto from 'crypto';
import { ingestMeeting } from './ingest.js';
import { config } from './config.js';

/**
 * Create the Express router for webhook endpoints.
 * Fathom (or Zapier) sends transcript data here after each meeting.
 */
export function createWebhookRouter() {
  const router = express.Router();

  /**
   * POST /webhook/fathom
   *
   * Receives meeting data from Fathom's webhook or via Zapier.
   *
   * If using Fathom's native webhook:
   *   - Configure at https://fathom.video/settings/integrations
   *   - Set the URL to: https://your-app.railway.app/webhook/fathom
   *
   * If using Zapier:
   *   - Trigger: Fathom > New Transcript
   *   - Action: Webhooks by Zapier > POST
   *   - URL: https://your-app.railway.app/webhook/fathom
   *   - Payload type: JSON
   *   - Map the fields as shown in README
   */
  router.post('/fathom', async (req, res) => {
    try {
      // Optional: verify webhook secret
      const providedSecret = req.headers['x-webhook-secret'];
      if (config.webhook.secret && providedSecret !== config.webhook.secret) {
        console.warn('⚠️ Webhook received with invalid secret');
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }

      const body = req.body;

      // Handle both Fathom native webhook format and Zapier format
      const meetingData = {
        fathomCallId: body.call_id || body.callId || body.id || `manual-${Date.now()}`,
        title: body.title || body.meeting_title || body.summary?.title || 'Untitled Meeting',
        date: body.date || body.created_at || body.started_at || new Date().toISOString(),
        durationSeconds: body.duration_seconds || body.duration || 0,
        attendees: body.attendees || body.participants || [],
        summary: body.summary?.text || body.ai_summary || body.summary || '',
        transcript: body.transcript?.text || body.transcript || body.full_transcript || '',
      };

      // Validate we have a transcript
      if (!meetingData.transcript || meetingData.transcript.length < 50) {
        console.warn('⚠️ Webhook received but transcript is too short or missing');
        return res.status(400).json({
          error: 'Transcript is required and must be at least 50 characters',
        });
      }

      console.log(`📨 Webhook received: "${meetingData.title}"`);

      // Ingest asynchronously (respond immediately, process in background)
      res.status(200).json({ status: 'accepted', title: meetingData.title });

      // Process after responding
      await ingestMeeting(meetingData);
      console.log(`✅ Webhook processing complete: "${meetingData.title}"`);
    } catch (error) {
      console.error('❌ Webhook error:', error);
      // Don't send error response if we already sent 200
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  });

  /**
   * GET /webhook/health
   * Simple health check endpoint.
   */
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}
