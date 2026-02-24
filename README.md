# 🧠 Fathom Brain

Your personal second brain — powered by your Fathom meeting transcripts and Claude.

Ask questions like:
- "What do I think about pricing strategies?"
- "What pain points do my customers keep mentioning?"
- "If I were to create a lead magnet, what topics would resonate?"
- "What did I discuss with [person] last week?"

And get answers grounded in what you've *actually said* on your calls.

---

## How It Works

1. **Fathom** records and transcribes your meetings
2. **Webhooks** automatically send new transcripts to your brain
3. **Supabase** stores them with vector embeddings for semantic search
4. **Slack bot** lets you query everything with Claude's latest model

---

## Setup Guide (30-40 minutes)

### Step 1: Supabase Database

You already have a Supabase account. Now:

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Create a new project (or use an existing one)
3. Go to **SQL Editor** → **New Query**
4. Copy the entire contents of `setup/schema.sql` and run it
5. You should see "Success" — your tables and vector index are ready

**Get your credentials:**
- Go to **Settings** → **API**
- Copy the **Project URL** (looks like `https://abc123.supabase.co`)
- Copy the **service_role** key (the secret one, NOT the anon key)

### Step 2: API Keys

You need 3 API keys:

| Service | Where to get it | Cost |
|---------|----------------|------|
| **Anthropic** (Claude) | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | ~$3/1M tokens (pay per query) |
| **OpenAI** (embeddings only) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | ~$0.02/1M tokens (pennies total) |
| **Fathom** | Fathom app → Settings → API / Integrations | Free with your plan |

### Step 3: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"** → **"From scratch"**
3. Name it `Fathom Brain` (or whatever you like)
4. Select your workspace

**Enable Socket Mode:**
1. Go to **Settings** → **Socket Mode** → Toggle ON
2. Click **"Generate"** to create an App-Level Token
3. Name it `brain-socket`, give it `connections:write` scope
4. Copy the token (starts with `xapp-`) — this is your `SLACK_APP_TOKEN`

**Set Bot Permissions:**
1. Go to **OAuth & Permissions**
2. Under **Bot Token Scopes**, add:
   - `app_mentions:read`
   - `chat:write`
   - `commands`
   - `im:history`
   - `im:read`
   - `im:write`

**Enable Events:**
1. Go to **Event Subscriptions** → Toggle ON
2. Under **Subscribe to Bot Events**, add:
   - `app_mention`
   - `message.im`

**Add Slash Command (optional but nice):**
1. Go to **Slash Commands** → **Create New Command**
2. Command: `/brain`
3. Description: `Ask your meeting brain a question`
4. Usage Hint: `What do my customers care about?`

**Install the App:**
1. Go to **Install App** → **Install to Workspace**
2. Authorize it
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — this is your `SLACK_BOT_TOKEN`

**Get Signing Secret:**
1. Go to **Basic Information**
2. Copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`

### Step 4: Configure Environment

```bash
cp .env.example .env
```

Fill in all the values in `.env` with the credentials you've gathered.

### Step 5: Deploy to Railway (free tier)

Railway gives you a free hobby plan — perfect for this.

1. Go to [railway.app](https://railway.app) and sign up with GitHub
2. Push your code to a GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   # Create a repo on GitHub, then:
   git remote add origin https://github.com/YOUR_USERNAME/fathom-brain.git
   git push -u origin main
   ```
3. In Railway: **New Project** → **Deploy from GitHub Repo** → Select your repo
4. Go to **Variables** tab and add ALL your `.env` variables
5. Railway auto-deploys. Check the **Deployments** tab for logs
6. Copy your Railway public URL (e.g., `https://fathom-brain-production.up.railway.app`)

### Step 6: Backfill Existing Recordings

Run this once to pull all your existing Fathom recordings into the brain:

```bash
# Locally (with .env configured):
npm install
npm run backfill

# Or via Railway CLI:
railway run npm run backfill
```

This fetches every call from Fathom, chunks the transcripts, generates embeddings, and stores everything.

### Step 7: Set Up Auto-Ingestion

**Option A: Fathom Native Webhook (simpler)**

If Fathom supports webhooks in your plan:
1. Go to Fathom → Settings → Webhooks / Integrations
2. Add a webhook URL: `https://YOUR-RAILWAY-URL/webhook/fathom`
3. Select events: "New recording" or "New transcript"

**Option B: Zapier (more reliable)**

1. Go to [zapier.com](https://zapier.com) and create an account
2. Create a new Zap:
   - **Trigger:** Fathom → New Transcript
   - **Action:** Webhooks by Zapier → POST
3. Configure the POST action:
   - URL: `https://YOUR-RAILWAY-URL/webhook/fathom`
   - Payload Type: JSON
   - Data:
     - `call_id` → Fathom Call ID
     - `title` → Fathom Meeting Title
     - `date` → Fathom Meeting Date
     - `transcript` → Fathom Transcript
     - `summary` → Fathom AI Summary
   - Headers:
     - `x-webhook-secret` → (the WEBHOOK_SECRET from your .env)
4. Test and turn on the Zap

### Step 8: Test It!

1. Open Slack
2. DM your Fathom Brain bot
3. Ask: "What topics come up most in my meetings?"
4. Or use `/brain What do my customers care about?`

---

## Usage Examples

| Question | What it does |
|----------|-------------|
| "What do I think about X?" | Searches for your opinions/statements about X across all calls |
| "What pain points do my customers have?" | Finds customer complaint patterns from sales/support calls |
| "Create a lead magnet topic list" | Synthesizes themes from your calls into content ideas |
| "What did I discuss with Sarah last Tuesday?" | Finds specific meeting context |
| "Summarize my thoughts on pricing" | Aggregates everything you've said about pricing |

---

## Costs Breakdown

| Service | Monthly Cost |
|---------|-------------|
| Supabase | Free (free tier: 500MB) |
| Railway | Free (hobby plan) |
| Zapier | Free (100 tasks/month) |
| OpenAI embeddings | ~$0.05 (for 50 meetings) |
| Claude API | ~$2-5 (depends on usage) |
| **Total** | **~$2-5/month** |

---

## Troubleshooting

**Slack bot not responding:**
- Check Railway logs for errors
- Make sure Socket Mode is enabled in Slack app settings
- Verify `SLACK_APP_TOKEN` starts with `xapp-`

**Backfill failing:**
- Check your `FATHOM_API_KEY` is correct
- Try running with `DEBUG=* npm run backfill` for more detail

**Webhook not receiving data:**
- Test with: `curl -X POST https://YOUR-URL/webhook/health`
- Check Zapier task history for errors
- Verify the webhook secret matches

**Search returning bad results:**
- Lower the similarity threshold in `src/search.js` (default 0.65)
- Make sure backfill completed successfully
- Check Supabase dashboard → Table Editor → chunks table has data
