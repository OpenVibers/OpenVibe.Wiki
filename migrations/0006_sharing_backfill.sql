-- phase: migrate
-- Every page that existed before sharing is registered once, so canView has a row for all of them.
--
--   a published page of a public space, public itself   → public  (Everyone)
--   everything else (drafts, members, vip, private)     → private (Only me; members/vip keep the gate)
--
-- The owner is the person who created the page; a page made by the service or an import with no
-- person gets Wiki itself, which nobody can sign in as. Deleted pages are not registered.
INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'wiki', 'page', p.id,
    CASE
        WHEN p.created_by LIKE 'usr\_%' THEN jsonb_build_object('type', 'user', 'id', p.created_by)
        WHEN p.created_by LIKE 'gst\_%' THEN jsonb_build_object('type', 'guest', 'id', p.created_by)
        ELSE jsonb_build_object('type', 'service', 'id', 'wiki')
    END,
    CASE
        WHEN p.state = 'published' AND p.visibility = 'public' AND s.visibility = 'public' THEN 'public'
        ELSE 'private'
    END
FROM wiki_pages p JOIN wiki_spaces s ON s.id = p.space_id
WHERE p.state <> 'deleted'
ON CONFLICT (service, kind, resource_id) DO NOTHING;
