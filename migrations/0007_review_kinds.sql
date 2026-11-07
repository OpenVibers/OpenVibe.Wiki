-- phase: expand
-- Two reviewer kinds in the append-only review log (server/wiki/review-kind.js; the AI editor
-- review of the editorial queue, plan 2026-10-22 §"The editorial queue"):
--
--   person     a signed-in person's approval or rejection (the default; every row written before
--              this migration, and every row openvibe-publishing/authorship reviews.record() writes);
--   ai_editor  the orchestrator's service principal, which holds wiki.review.ai_editor.
--
-- Expand only: existing rows keep their meaning through the default, and code that does not know
-- the column (the shared log's INSERT, older processes during a rolling deploy) keeps working.
ALTER TABLE wiki_page_reviews
    ADD COLUMN IF NOT EXISTS reviewer_kind text NOT NULL DEFAULT 'person'
        CHECK (reviewer_kind IN ('person', 'ai_editor'));
