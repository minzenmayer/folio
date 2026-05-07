-- Phase 23 v2 slice 7 (2026-05-07)
-- chat_sessions: persist a Writing × With-assistant coaching thread
-- so navigating away does not wipe progress. Re-entry via
-- /studio?chat=<id> rehydrates the thread + stage.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Auto-generated short label (4-6 words) shown in the sidebar.
  -- Falls back to a slugified topic when LLM auto-name is skipped.
  title text NOT NULL,

  -- The original topic the user submitted on entry. Useful both
  -- for re-running propose against and for surfacing in lists.
  topic text NOT NULL,

  -- Platform locked on the first proposal. 'newsletter' | 'linkedin'
  -- | 'unknown'. Mirrors ProposeFromTopicResult.platformGuess.
  platform_guess text NOT NULL DEFAULT 'unknown',

  -- The full turn array as JSON. Mirrors CoachTurn[] in the client:
  -- { kind: 'user' | 'assistant', text?, proposal?, carried* }.
  -- LLM can rebuild conversationSoFar from this on the server when
  -- the user resumes mid-thread.
  turns jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Which stage the client was in when last persisted. 'thread'
  -- (initial proposal still showing) | 'coaching' (chat in
  -- progress) | 'finalized' (commitProposal already redirected).
  stage text NOT NULL DEFAULT 'coaching',

  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Recent-session lookups in the sidebar order by updated_at desc
-- per user. Index makes that cheap.
CREATE INDEX IF NOT EXISTS chat_sessions_user_updated_idx
  ON chat_sessions (user_id, updated_at DESC);
