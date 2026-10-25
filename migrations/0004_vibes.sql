-- phase: expand
-- "Vibe a wiki" (server/wiki/vibe.js): one row per generated wiki. A worker takes a queued or stalled job under a lease,
-- researches the topic through OpenVibe.AI (research.gather), plans the pages (wiki.generate_space), writes each one
-- (wiki.generate_page) with its pictures copied into OpenVibe.Media, and records progress here as it goes, so a restart
-- resumes where it stopped (pages already made are skipped).
CREATE TABLE IF NOT EXISTS wiki_vibes (
    id            text PRIMARY KEY,
    space_id      text NOT NULL REFERENCES wiki_spaces (id) ON DELETE CASCADE,
    topic         text NOT NULL,
    lang          text NOT NULL DEFAULT 'en',
    size          text NOT NULL DEFAULT 'standard' CHECK (size IN ('quick', 'standard', 'big')),
    status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'researching', 'planning', 'writing', 'done', 'failed', 'cancelled')),
    requested_by  text NOT NULL,
    plan          jsonb,
    progress      jsonb NOT NULL DEFAULT '{}'::jsonb,
    error         text,
    attempts      integer NOT NULL DEFAULT 0,
    lease_owner   text,
    lease_until   bigint,
    retry_at      bigint,
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    finished_at   bigint
);
CREATE INDEX IF NOT EXISTS wiki_vibes_due_idx ON wiki_vibes (status, retry_at) WHERE status IN ('queued', 'researching', 'planning', 'writing');
CREATE INDEX IF NOT EXISTS wiki_vibes_requested_idx ON wiki_vibes (requested_by, created_at DESC);
CREATE INDEX IF NOT EXISTS wiki_vibes_space_idx ON wiki_vibes (space_id);
