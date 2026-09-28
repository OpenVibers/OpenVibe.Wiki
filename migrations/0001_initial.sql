-- phase: expand
-- OpenVibe.Wiki on PostgreSQL (ADR-035, roadmap WS-X2): the ten authority tables of roadmap 15.13 as they were on
-- SQLite, typed for PostgreSQL (epoch milliseconds stay bigint; 0/1 flags stay integer so the API is unchanged),
-- then the openvibe-publishing stores and the openvibe-sdk outbox. Identifier columns sort like SQLite (COLLATE "C").
-- Generated once on 2026-09-28; never edited after it runs (a change is the next migration).

CREATE TABLE wiki_spaces (
    id           text COLLATE "C" PRIMARY KEY,
    slug         text COLLATE "C" NOT NULL UNIQUE,
    name         text NOT NULL,
    description  text,
    kind         text NOT NULL CHECK (kind IN ('official','user')),
    visibility   text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','members','vip','private')),
    owner        text COLLATE "C" NOT NULL,
    created_by   text NOT NULL,
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    deleted_at   bigint
);

CREATE TABLE wiki_pages (
    id                    text COLLATE "C" PRIMARY KEY,
    space_id              text COLLATE "C" NOT NULL REFERENCES wiki_spaces(id),
    slug                  text COLLATE "C" NOT NULL,
    title                 text NOT NULL,
    parent_id             text COLLATE "C" REFERENCES wiki_pages(id),
    position              integer NOT NULL DEFAULT 0,
    state                 text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','scheduled','published','unpublished','deleted')),
    visibility            text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','members','vip','private')),
    noindex               integer NOT NULL DEFAULT 0,
    published_revision    integer,
    published_at          bigint,
    revision_published_at bigint,
    created_by            text NOT NULL,
    created_at            bigint NOT NULL,
    updated_at            bigint NOT NULL,
    UNIQUE (space_id, slug)
);
CREATE INDEX wiki_pages_parent ON wiki_pages (space_id, parent_id, position);
CREATE INDEX wiki_pages_children ON wiki_pages (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX wiki_pages_updated ON wiki_pages (updated_at);
CREATE INDEX wiki_pages_recent ON wiki_pages (revision_published_at DESC, id) WHERE state = 'published';

CREATE TABLE wiki_page_links (
    from_page_id  text COLLATE "C" NOT NULL,
    from_revision integer NOT NULL,
    target_space  text COLLATE "C" NOT NULL,
    target_slug   text COLLATE "C" NOT NULL,
    label         text,
    PRIMARY KEY (from_page_id, from_revision, target_space, target_slug)
);
CREATE INDEX wiki_page_links_target ON wiki_page_links (target_space, target_slug);

CREATE TABLE wiki_infobox_values (
    page_id      text COLLATE "C" NOT NULL,
    revision     integer NOT NULL,
    position     integer NOT NULL,
    key          text COLLATE "C" NOT NULL,
    label        text NOT NULL,
    type         text NOT NULL CHECK (type IN ('text','number','date','url','boolean','page','media')),
    value_text   text,
    value_number double precision,
    PRIMARY KEY (page_id, revision, key)
);

CREATE TABLE wiki_permissions (
    space_id    text COLLATE "C" NOT NULL REFERENCES wiki_spaces(id),
    subject     text COLLATE "C" NOT NULL,
    role        text COLLATE "C" NOT NULL CHECK (role IN ('owner','editor','viewer')),
    granted_by  text,
    granted_at  bigint NOT NULL,
    PRIMARY KEY (space_id, subject)
);
CREATE INDEX wiki_permissions_subject ON wiki_permissions (subject);

-- People whose wiki.projects user module (Network) needs writing again: marked in the same transaction as the space or
-- role change, drained by server/integrations/projects-module.js.
CREATE TABLE wiki_module_dirty (
    subject     text COLLATE "C" PRIMARY KEY,
    marked_at   bigint NOT NULL
);
CREATE TABLE wiki_module_pushes (
    subject     text COLLATE "C" PRIMARY KEY,
    hash        text NOT NULL,
    pushed_at   bigint NOT NULL
);

CREATE TABLE wiki_watchers (
    page_id     text COLLATE "C" NOT NULL REFERENCES wiki_pages(id),
    subject     text COLLATE "C" NOT NULL,
    created_at  bigint NOT NULL,
    PRIMARY KEY (page_id, subject)
);

CREATE TABLE wiki_ai_proposals (
    id             text COLLATE "C" PRIMARY KEY,
    page_id        text COLLATE "C" NOT NULL REFERENCES wiki_pages(id),
    space_id       text COLLATE "C" NOT NULL REFERENCES wiki_spaces(id),
    revision       integer NOT NULL,
    base_revision  integer NOT NULL,
    workflow_id    text NOT NULL,
    run_id         text NOT NULL,
    stub_provider  integer NOT NULL DEFAULT 0,
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    proposed_by    text NOT NULL,
    note           text,
    reviewed_by    text,
    review_note    text,
    reviewed_at    bigint,
    created_at     bigint NOT NULL,
    UNIQUE (page_id, revision)
);
CREATE INDEX wiki_ai_proposals_status ON wiki_ai_proposals (status, created_at);
CREATE INDEX wiki_ai_proposals_page ON wiki_ai_proposals (page_id, created_at DESC);

-- Who attached a Media object to a page, and what Media said about it at that moment. One row per attachment,
-- written with it and never changed.
CREATE TABLE wiki_attachment_origins (
    attachment_id     bigint PRIMARY KEY,
    page_id           text COLLATE "C" NOT NULL,
    media_id          text COLLATE "C" NOT NULL,
    attached_by       text NOT NULL,
    media_owner       text,
    media_visibility  text NOT NULL CHECK (media_visibility IN ('public','unlisted','private')),
    attached_at       bigint NOT NULL
);
CREATE INDEX wiki_attachment_origins_page ON wiki_attachment_origins (page_id);

-- openvibe-publishing/revisions (prefix wiki_page)
CREATE TABLE IF NOT EXISTS wiki_page_revisions (
    id            text PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    number        integer NOT NULL CHECK (number >= 1),
    parent_id     text,
    parent_number integer,
    kind          text NOT NULL CHECK (kind IN ('edit','revert','import')),
    reverted_to   integer,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    content_hash  text NOT NULL,
    author        text,
    message       text,
    created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_page_revisions_entity_num ON wiki_page_revisions (entity_id, number);
CREATE TABLE IF NOT EXISTS wiki_page_drafts (
    entity_id     text COLLATE "C" NOT NULL,
    owner         text COLLATE "C" NOT NULL,
    base_revision integer NOT NULL,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    PRIMARY KEY (entity_id, owner)
);
CREATE INDEX IF NOT EXISTS wiki_page_drafts_updated ON wiki_page_drafts (entity_id, updated_at DESC, owner);
CREATE TABLE IF NOT EXISTS wiki_page_revision_purges (
    entity_id   text COLLATE "C" PRIMARY KEY,
    reason      text NOT NULL,
    purged_by   text,
    purged_at   bigint NOT NULL
);
CREATE OR REPLACE FUNCTION wiki_page_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'wiki_page_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wiki_page_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'wiki_page_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER wiki_page_revisions_no_update BEFORE UPDATE ON wiki_page_revisions FOR EACH ROW EXECUTE FUNCTION wiki_page_revisions_guard();
CREATE OR REPLACE TRIGGER wiki_page_revisions_no_delete BEFORE DELETE ON wiki_page_revisions FOR EACH ROW EXECUTE FUNCTION wiki_page_revisions_guard();

-- openvibe-publishing/citations (prefix wiki)
CREATE TABLE IF NOT EXISTS wiki_citations (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id      text COLLATE "C" NOT NULL,
    revision       integer NOT NULL CHECK (revision >= 1),
    anchor         text,
    source_item_id text COLLATE "C",
    url            text,
    title          text,
    retrieved_at   timestamptz,
    quote_text     text,
    quote_start    integer,
    quote_end      integer,
    license_note   text,
    carried_from   bigint REFERENCES wiki_citations(id),
    attached_by    text,
    attached_at    bigint NOT NULL,
    CHECK (source_item_id IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS wiki_citations_rev ON wiki_citations (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS wiki_citations_source ON wiki_citations (source_item_id, entity_id, revision, id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wiki_citations_carried ON wiki_citations (carried_from) WHERE carried_from IS NOT NULL;
CREATE TABLE IF NOT EXISTS wiki_citation_purges (
    entity_id text COLLATE "C" PRIMARY KEY,
    reason    text NOT NULL,
    purged_by text,
    purged_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION wiki_citations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'wiki_citations rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wiki_citation_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'wiki_citations rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER wiki_citations_no_update BEFORE UPDATE ON wiki_citations FOR EACH ROW EXECUTE FUNCTION wiki_citations_guard();
CREATE OR REPLACE TRIGGER wiki_citations_no_delete BEFORE DELETE ON wiki_citations FOR EACH ROW EXECUTE FUNCTION wiki_citations_guard();

-- openvibe-publishing/seo (prefix wiki_page)
CREATE TABLE IF NOT EXISTS wiki_page_redirects (
    from_path  text COLLATE "C" PRIMARY KEY,
    entity_id  text COLLATE "C" NOT NULL,
    reason     text,
    created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS wiki_page_redirects_entity ON wiki_page_redirects (entity_id, created_at, from_path);

-- openvibe-publishing/authorship (prefix wiki_page)
CREATE TABLE IF NOT EXISTS wiki_page_reviews (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id   text COLLATE "C" NOT NULL,
    revision    integer NOT NULL,
    reviewer    text NOT NULL,
    decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
    note        text,
    reviewed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS wiki_page_reviews_rev ON wiki_page_reviews (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS wiki_page_reviews_entity ON wiki_page_reviews (entity_id, id);
CREATE OR REPLACE FUNCTION wiki_page_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'wiki_page_reviews rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER wiki_page_reviews_no_update BEFORE UPDATE ON wiki_page_reviews FOR EACH ROW EXECUTE FUNCTION wiki_page_reviews_guard();

-- openvibe-publishing/media (prefix wiki_page)
CREATE TABLE IF NOT EXISTS wiki_page_attachments (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    revision      integer,
    media_id      text COLLATE "C" NOT NULL,
    role          text NOT NULL DEFAULT 'inline',
    variant       text,
    alt           text,
    caption       text,
    position      integer NOT NULL DEFAULT 0,
    state         text NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified','available','broken')),
    broken_reason text CHECK (broken_reason IS NULL OR broken_reason IN ('not_found','deleted','forbidden')),
    checked_at    bigint,
    created_at    bigint NOT NULL,
    CHECK ((state = 'broken') = (broken_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS wiki_page_attachments_entity ON wiki_page_attachments (entity_id, position, id);
CREATE INDEX IF NOT EXISTS wiki_page_attachments_media ON wiki_page_attachments (media_id, entity_id);

-- openvibe-publishing/discussion (prefix wiki)
CREATE TABLE IF NOT EXISTS wiki_discussion_refs (
    entity_id   text COLLATE "C" PRIMARY KEY,
    thread_id   text NOT NULL,
    ref         jsonb NOT NULL,
    resolved_at bigint NOT NULL
);

-- openvibe-publishing/schedule (prefix wiki)
CREATE TABLE IF NOT EXISTS wiki_schedule_jobs (
    id          text COLLATE "C" PRIMARY KEY,
    idem_key    text NOT NULL UNIQUE,
    entity_id   text COLLATE "C" NOT NULL,
    action      text NOT NULL CHECK (action IN ('publish','unpublish')),
    revision    integer,
    run_at      bigint NOT NULL,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
    attempts    integer NOT NULL DEFAULT 0,
    lease_owner text,
    lease_until bigint,
    last_error  text,
    result      jsonb,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS wiki_schedule_jobs_due ON wiki_schedule_jobs (run_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS wiki_schedule_jobs_lease ON wiki_schedule_jobs (lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS wiki_schedule_jobs_entity ON wiki_schedule_jobs (entity_id, run_at, id);

-- openvibe-publishing/index-hooks (prefix wiki)
CREATE TABLE IF NOT EXISTS wiki_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);


-- Immutable side tables (the SQLite RAISE(ABORT) triggers), as PL/pgSQL with the same messages.
CREATE FUNCTION wiki_rows_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;
CREATE FUNCTION wiki_infobox_values_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM wiki_page_revision_purges WHERE entity_id = OLD.page_id) THEN
        RAISE EXCEPTION 'wiki_infobox_values rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE TRIGGER wiki_infobox_values_no_update BEFORE UPDATE ON wiki_infobox_values FOR EACH ROW EXECUTE FUNCTION wiki_rows_immutable();
CREATE TRIGGER wiki_infobox_values_no_delete BEFORE DELETE ON wiki_infobox_values FOR EACH ROW EXECUTE FUNCTION wiki_infobox_values_no_delete();
CREATE TRIGGER wiki_page_links_no_update BEFORE UPDATE ON wiki_page_links FOR EACH ROW EXECUTE FUNCTION wiki_rows_immutable();
CREATE TRIGGER wiki_attachment_origins_no_update BEFORE UPDATE ON wiki_attachment_origins FOR EACH ROW EXECUTE FUNCTION wiki_rows_immutable();

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS wiki_event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS wiki_event_outbox_due ON wiki_event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS wiki_event_outbox_sent ON wiki_event_outbox (sent_at) WHERE sent_at IS NOT NULL;
