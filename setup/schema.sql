-- ============================================
-- FATHOM BRAIN - Supabase Schema Setup
-- ============================================
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- This sets up pgvector and the tables needed for your meeting brain.

-- 1. Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Main meetings table (stores metadata for each meeting)
CREATE TABLE IF NOT EXISTS meetings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fathom_call_id TEXT UNIQUE,
  title TEXT,
  date TIMESTAMPTZ,
  duration_seconds INTEGER,
  attendees TEXT[],
  summary TEXT,
  full_transcript TEXT,
  source TEXT DEFAULT 'fathom',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Chunks table (transcript split into searchable pieces with embeddings)
CREATE TABLE IF NOT EXISTS chunks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
  chunk_index INTEGER,
  content TEXT NOT NULL,
  token_count INTEGER,
  embedding VECTOR(1536),  -- OpenAI text-embedding-3-small dimension
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Index for fast vector similarity search
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 5. Index for looking up chunks by meeting
CREATE INDEX IF NOT EXISTS chunks_meeting_id_idx ON chunks(meeting_id);

-- 6. Full-text search index on chunk content (backup search method)
CREATE INDEX IF NOT EXISTS chunks_content_fts_idx
  ON chunks
  USING gin(to_tsvector('english', content));

-- 7. Function to search chunks by semantic similarity
CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  meeting_id UUID,
  content TEXT,
  similarity FLOAT,
  meeting_title TEXT,
  meeting_date TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.meeting_id,
    c.content,
    1 - (c.embedding <=> query_embedding) AS similarity,
    m.title AS meeting_title,
    m.date AS meeting_date
  FROM chunks c
  JOIN meetings m ON c.meeting_id = m.id
  WHERE 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 8. Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meetings_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Done! Your database is ready.
