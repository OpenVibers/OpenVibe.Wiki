-- phase: expand
-- Sharing defaults on a wiki (VISIBILITY-EVERYWHERE-DESIGN-2026-11-06 rules 1-2): the audience a new
-- page starts with, set by the wiki's owner on its settings page, plus "apply it to every page".
-- Existing wikis keep Everyone, which is what their create form already offered. Expand only.
ALTER TABLE wiki_spaces ADD COLUMN IF NOT EXISTS default_visibility text NOT NULL DEFAULT 'public';
DO $$ BEGIN
    ALTER TABLE wiki_spaces ADD CONSTRAINT wiki_spaces_default_visibility_allowed
        CHECK (default_visibility IN ('public','members','vip','private'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
