-- phase: expand
-- ADR-033 account deletion (server/wiki/account-data.js) and the account-data receipts.
--
-- account_data_events: the receipts of the account export and deletion deliveries this service applied
-- (openvibe-sdk/account-data's ACCOUNT_DATA_SCHEMA), so a redelivered export or deletion changes nothing. A row holds
-- an export_id or deletion_id, the subject and the counts sent to Network; it is not a secret.
--
-- Page revisions and citations stay append-only, with one exception. Inside the account-erasure transaction, and
-- only there (it sets wiki.account_erasure = 'on' with set_config(..., true), so the setting ends with the
-- transaction), the person's id may leave a row: a revision's author becomes NULL and their id leaves
-- meta.authorship.authors (also on a revision someone else wrote with them), and a citation's attached_by becomes
-- NULL. Every other column must stay as it was, so the text, the sources and their provenance never change. Deletes
-- keep their old rules (only after a recorded purge).

CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION wiki_page_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF current_setting('wiki.account_erasure', true) = 'on'
            AND (NEW.author IS NULL OR NEW.author IS NOT DISTINCT FROM OLD.author)
            AND (NEW.id, NEW.entity_id, NEW.number, NEW.parent_id, NEW.parent_number, NEW.kind, NEW.reverted_to, NEW.content,
                 NEW.fields, NEW.content_hash, NEW.message, NEW.created_at)
                IS NOT DISTINCT FROM
                (OLD.id, OLD.entity_id, OLD.number, OLD.parent_id, OLD.parent_number, OLD.kind, OLD.reverted_to, OLD.content,
                 OLD.fields, OLD.content_hash, OLD.message, OLD.created_at)
            AND (NEW.meta - 'authorship') IS NOT DISTINCT FROM (OLD.meta - 'authorship')
            AND ((NEW.meta->'authorship') - 'authors') IS NOT DISTINCT FROM ((OLD.meta->'authorship') - 'authors') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'wiki_page_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wiki_page_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'wiki_page_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION wiki_citations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF current_setting('wiki.account_erasure', true) = 'on' AND NEW.attached_by IS NULL
            AND (NEW.id, NEW.entity_id, NEW.revision, NEW.anchor, NEW.source_item_id, NEW.url, NEW.title, NEW.retrieved_at,
                 NEW.quote_text, NEW.quote_start, NEW.quote_end, NEW.license_note, NEW.carried_from, NEW.attached_at)
                IS NOT DISTINCT FROM
                (OLD.id, OLD.entity_id, OLD.revision, OLD.anchor, OLD.source_item_id, OLD.url, OLD.title, OLD.retrieved_at,
                 OLD.quote_text, OLD.quote_start, OLD.quote_end, OLD.license_note, OLD.carried_from, OLD.attached_at) THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'wiki_citations rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wiki_citation_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'wiki_citations rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
