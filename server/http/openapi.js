'use strict';
/**
 * OpenAPI 3.1 for OpenVibe.Wiki's JSON API, from the route table below.
 *
 * ROUTES is the table: every entry is one method on one path under /api/v1, with the operation the
 * router serves. server/http/api.js mounts exactly these, and test/openapi.test.js walks the mounted
 * router and fails when the two differ in either direction — so the document can never advertise an
 * address this service does not answer.
 *
 *   GET /openapi.json           this document (public, Cache-Control 5 minutes)
 *   GET /api/v1/openapi.json    308 to /openapi.json
 *
 * Request fields come from what the handlers read out of the body (api.js) and what the domain
 * validates (wiki/service.js); response properties are the serializers' output. Nothing is inferred
 * that the code does not say.
 */
const pkg = require('../../package.json');

const MOUNT = '/api/v1';
const SITE = 'https://openvibe.wiki';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const arrayOf = (items) => ({ type: 'array', items });

const problem = {
    description: 'A problem (RFC 9457, application/problem+json): type, title, status and a stable code',
    content: {
        'application/problem+json': {
            schema: {
                type: 'object',
                required: ['type', 'title', 'status'],
                properties: {
                    type: str(), title: str(), status: { type: 'integer' }, code: str(),
                    detail: str(), request_id: str(),
                },
            },
        },
    },
};
const errors = (codes = [400, 401, 403, 404, 409, 413, 422, 429]) => ({
    ...Object.fromEntries(codes.map((code) => [code, problem])),
    default: problem,
});

const path = (name, schema, description) => ({ name, in: 'path', required: true, schema, ...(description && { description }) });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });

const SPACE = path('space', str(), 'The space slug (2–63 lowercase letters, digits and dashes) or its spc_ id');
const PAGE = path('id', { type: 'string', pattern: '^pg_[0-9A-HJKMNP-TV-Z]{26}$' }, 'The page id');
const REVISION = path('n', { type: 'integer', minimum: 1 }, 'The revision number');
const SUBJECT = path('subject', { type: 'string', pattern: '^usr_[0-9A-HJKMNP-TV-Z]{26}$' }, 'The person (usr_ id)');
const PROPOSAL = path('id', { type: 'string', pattern: '^prp_[0-9A-HJKMNP-TV-Z]{26}$' }, 'The proposal id');
const VIBE = path('vibe', { type: 'string', pattern: '^vib_[0-9A-HJKMNP-TV-Z]{26}$' }, 'The generated wiki id');

const ANONYMOUS = [{}];
const PERSON = [{ bearer: [] }, { cookie: [] }];

const json = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });

const citation = { type: 'object', properties: {
    url: nullable('string'), source_item_id: str({ description: 'An OpenVibe.Sources item: its url, title, retrieval time and licence are taken from its provenance' }),
    title: nullable('string'), retrieved_at: nullable('string', { format: 'date-time' }),
    quote: nullable('string', { maxLength: 5000 }), license_note: nullable('string'), anchor: nullable('string'),
} };
const infobox = arrayOf({ type: 'object', required: ['key', 'value'], properties: { key: str({ maxLength: 40 }), value: str({ maxLength: 2000 }) } });

/** The tables the routes index, sorted by path so the document is stable. */
const PATHS = {};
function route(method, p, operation) {
    (PATHS[p] = PATHS[p] || {})[method] = operation;
}

route('get', '/spaces', {
    operationId: 'listSpaces', summary: 'The spaces the caller can read', tags: ['spaces'], security: ANONYMOUS,
    responses: { 200: json('Readable spaces', { type: 'object', required: ['spaces'], properties: { spaces: arrayOf(ref('Space')) } }), ...errors([400, 401, 429]) },
});
route('post', '/spaces', {
    operationId: 'createSpace', summary: 'Create a space', tags: ['spaces'], security: PERSON,
    description: 'wiki.space.create. A person creates a user space; an official space is for Network staff and first-party services.',
    requestBody: body({ type: 'object', required: ['name'], properties: {
        slug: str({ pattern: '^[a-z0-9-]{2,63}$' }), name: str({ maxLength: 120 }), description: str({ maxLength: 1000 }),
        kind: { type: 'string', enum: ['official', 'user'], default: 'user' },
        visibility: { type: 'string', enum: ['public', 'members', 'vip', 'private'], default: 'public' },
    } }),
    responses: { 201: json('The space', { type: 'object', required: ['space'], properties: { space: ref('Space') } }), ...errors() },
});
route('get', '/spaces/{space}', {
    operationId: 'getSpace', summary: 'A space and its page tree', tags: ['spaces'], security: ANONYMOUS, parameters: [SPACE],
    responses: { 200: json('The space and its tree', { type: 'object', required: ['space', 'pages'], properties: { space: ref('Space'), pages: arrayOf(ref('PageTree')) } }), ...errors([400, 401, 404, 429]) },
});
route('patch', '/spaces/{space}', {
    operationId: 'updateSpace', summary: 'Rename, re-slug or change a space\'s visibility', tags: ['spaces'], security: PERSON, parameters: [SPACE],
    description: 'wiki.space.create. Owners only.',
    requestBody: body({ type: 'object', properties: { name: str({ maxLength: 120 }), description: str({ maxLength: 1000 }), visibility: { type: 'string', enum: ['public', 'members', 'vip', 'private'] }, slug: str({ pattern: '^[a-z0-9-]{2,63}$' }) } }),
    responses: { 200: json('The space', { type: 'object', properties: { space: ref('Space') } }), ...errors() },
});
route('get', '/spaces/{space}/roles', {
    operationId: 'getSpaceRoles', summary: 'The space\'s role list', tags: ['spaces'], security: PERSON, parameters: [SPACE],
    responses: { 200: json('Who holds which role', { type: 'object', properties: { roles: arrayOf(ref('Role')) } }), ...errors([400, 401, 403, 404, 429]) },
});
route('put', '/spaces/{space}/roles/{subject}', {
    operationId: 'setSpaceRole', summary: 'Grant or remove a person\'s role in a space', tags: ['spaces'], security: PERSON, parameters: [SPACE, SUBJECT],
    description: 'wiki.space.create. Owners only. role: owner, editor, viewer, or null to remove.',
    requestBody: body({ type: 'object', required: ['role'], properties: { role: { type: ['string', 'null'], enum: ['owner', 'editor', 'viewer', null] } } }),
    responses: { 200: json('The role list', { type: 'object', properties: { roles: arrayOf(ref('Role')) } }), ...errors() },
});
route('post', '/spaces/{space}/pages', {
    operationId: 'createPage', summary: 'Create a draft page in a space', tags: ['pages'], security: PERSON, parameters: [SPACE],
    description: 'wiki.page.create.',
    requestBody: body({ type: 'object', required: ['title', 'body'], properties: {
        title: str({ maxLength: 200 }), body: str({ maxLength: 200000, description: 'Markdown' }), summary: str({ maxLength: 300 }),
        infobox, parent_id: nullable('string'), visibility: { type: 'string', enum: ['public', 'members', 'vip', 'private'] },
        citations: arrayOf(citation), message: nullable('string'),
    } }),
    responses: { 201: json('The draft, its first revision and its citations', ref('CreatedPage')), ...errors() },
});
route('post', '/spaces/{space}/import', {
    operationId: 'importPages', summary: 'Import a bundle of pages, all or nothing', tags: ['pages'], security: PERSON, parameters: [SPACE],
    description: 'wiki.page.create. At most 200 pages in one transaction (server/wiki/import.js).',
    requestBody: body({ type: 'object', required: ['pages'], properties: {
        pages: arrayOf({ type: 'object' }), publish: { type: 'boolean' },
        on_existing: { type: 'string', enum: ['skip', 'fail', 'replace'] }, source: nullable('string'),
        original_author: nullable('string'), ai_assisted: { type: 'boolean' },
    } }),
    responses: { 201: json('What the import wrote', { type: 'object', properties: { space: ref('Space'), published: { type: 'boolean' }, skipped: { type: 'integer' }, created: arrayOf({ type: 'object' }) } }), ...errors() },
});
route('get', '/pages/{id}', {
    operationId: 'getPage', summary: 'A page and one revision of it', tags: ['pages'], security: ANONYMOUS, parameters: [PAGE, query('revision', { type: 'integer', minimum: 1 }, 'Read this revision instead of the published head')],
    responses: { 200: json('The page, its revision, citations, infobox, attachments, links and indexability', ref('PageView')), ...errors([400, 401, 404, 429]) },
});
route('patch', '/pages/{id}', {
    operationId: 'updatePage', summary: 'Move, re-slug or change a page\'s visibility or noindex', tags: ['pages'], security: PERSON, parameters: [PAGE],
    description: 'wiki.page.create.',
    requestBody: body({ type: 'object', properties: { slug: str(), parent_id: nullable('string'), visibility: { type: 'string', enum: ['public', 'members', 'vip', 'private'] }, noindex: { type: 'boolean' } } }),
    responses: { 200: json('The page', { type: 'object', properties: { page: ref('Page') } }), ...errors() },
});
route('delete', '/pages/{id}', {
    operationId: 'deletePage', summary: 'Delete a page (its address answers 410)', tags: ['pages'], security: PERSON, parameters: [PAGE],
    description: 'wiki.page.create. Owners only.',
    responses: { 200: json('The deleted page', { type: 'object', properties: { page: ref('Page') } }), ...errors() },
});
route('get', '/pages/{id}/revisions', {
    operationId: 'listRevisions', summary: 'A page\'s revision history', tags: ['revisions'], security: ANONYMOUS, parameters: [PAGE,
        query('before', { type: 'integer', minimum: 1 }, 'The cursor: the newest revision to return'), query('limit', { type: 'integer', minimum: 1, maximum: 100 })],
    responses: { 200: json('Revisions, newest first', { type: 'object', properties: { revisions: arrayOf(ref('RevisionSummary')) } }), ...errors([400, 401, 404, 429]) },
});
route('post', '/pages/{id}/revisions', {
    operationId: 'editPage', summary: 'Write a new revision of a page', tags: ['revisions'], security: PERSON, parameters: [PAGE],
    description: 'wiki.page.create. expected_revision makes the write conditional: a stale number answers 409.',
    requestBody: body({ type: 'object', required: ['expected_revision'], properties: {
        expected_revision: { type: 'integer', minimum: 0 }, title: str({ maxLength: 200 }), body: str({ maxLength: 200000 }),
        summary: str({ maxLength: 300 }), infobox, citations: arrayOf(citation),
        keep_citations: { type: 'string', description: 'all (default), none, or the numbers to carry' }, message: nullable('string'),
    } }),
    responses: { 200: json('Unchanged content: the existing head', ref('CreatedPage')), 201: json('The new revision', ref('CreatedPage')), ...errors() },
});
route('get', '/pages/{id}/revisions/{n}', {
    operationId: 'getRevision', summary: 'One revision of a page', tags: ['revisions'], security: ANONYMOUS, parameters: [PAGE, REVISION],
    responses: { 200: json('The revision and its citations', ref('RevisionView')), ...errors([400, 401, 404, 429]) },
});
route('get', '/pages/{id}/diff', {
    operationId: 'diffRevisions', summary: 'The diff between two revisions', tags: ['revisions'], security: ANONYMOUS, parameters: [PAGE,
        query('from', { type: 'integer', minimum: 1 }, 'Required'), query('to', { type: 'integer', minimum: 1 }, 'Required'),
        query('mode', { type: 'string', enum: ['word', 'line'] }, 'word (default) or line')],
    responses: { 200: json('{ diff }', { type: 'object', properties: { diff: { type: 'object' } } }), ...errors([400, 401, 404, 429]) },
});
route('get', '/pages/{id}/revisions/{n}/citations', {
    operationId: 'listCitations', summary: 'A revision\'s citations', tags: ['citations'], security: ANONYMOUS, parameters: [PAGE, REVISION],
    responses: { 200: json('The citations', { type: 'object', properties: { citations: arrayOf(ref('Citation')) } }), ...errors([400, 401, 404, 429]) },
});
route('post', '/pages/{id}/revisions/{n}/citations', {
    operationId: 'attachCitations', summary: 'Attach citations to the unpublished head', tags: ['citations'], security: PERSON, parameters: [PAGE, REVISION],
    description: 'wiki.citation.attach. Sources item ids are looked up in OpenVibe.Sources. At most 50 per request.',
    requestBody: body({ type: 'object', required: ['citations'], properties: { citations: arrayOf(citation) } }),
    responses: { 201: json('The revision\'s citations', { type: 'object', properties: { citations: arrayOf(ref('Citation')) } }), ...errors() },
});
route('post', '/pages/{id}/revisions/{n}/review', {
    operationId: 'reviewRevision', summary: 'Approve or reject a revision', tags: ['revisions'], security: PERSON, parameters: [PAGE, REVISION],
    description: 'wiki.revision.publish. A person (owner or editor); an approved AI-assisted revision becomes indexable when it publishes.',
    requestBody: body({ type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['approved', 'rejected'] }, note: nullable('string') } }),
    responses: { 201: json('The review and what it changed', { type: 'object', properties: { review: { type: 'object' }, page: ref('Page'), action: nullable('string'), indexable: { type: 'boolean' }, reasons: arrayOf(str()) } }), ...errors() },
});
route('post', '/pages/{id}/publish', {
    operationId: 'publishPage', summary: 'Publish a page\'s head (or a named revision)', tags: ['pages'], security: PERSON, parameters: [PAGE],
    description: 'wiki.revision.publish.',
    requestBody: body({ type: 'object', properties: { revision: { type: 'integer', minimum: 1 } } }, false),
    responses: { 200: json('The page and what happened', { type: 'object', properties: { page: ref('Page'), action: nullable('string') } }), ...errors() },
});
route('post', '/pages/{id}/schedule', {
    operationId: 'schedulePublication', summary: 'Schedule a publication', tags: ['pages'], security: PERSON, parameters: [PAGE],
    description: 'wiki.revision.publish. created is false when a job for that time already existed.',
    requestBody: body({ type: 'object', required: ['run_at'], properties: { revision: { type: 'integer', minimum: 1 }, run_at: str({ format: 'date-time' }) } }),
    responses: { 200: json('The existing job', { type: 'object', properties: { job: { type: 'object' }, created: { type: 'boolean' } } }), 201: json('The new job', { type: 'object', properties: { job: { type: 'object' }, created: { type: 'boolean' } } }), ...errors() },
});
route('post', '/pages/{id}/unpublish', {
    operationId: 'unpublishPage', summary: 'Unpublish a page', tags: ['pages'], security: PERSON, parameters: [PAGE],
    description: 'wiki.revision.publish.',
    responses: { 200: json('The page and what happened', { type: 'object', properties: { page: ref('Page'), action: nullable('string') } }), ...errors() },
});
route('post', '/pages/{id}/revert', {
    operationId: 'revertPage', summary: 'Revert a page to an earlier revision', tags: ['revisions'], security: PERSON, parameters: [PAGE],
    description: 'wiki.revision.revert. The revert is a new revision, not a rewrite of history.',
    requestBody: body({ type: 'object', required: ['to_revision', 'expected_revision'], properties: {
        to_revision: { type: 'integer', minimum: 1 }, expected_revision: { type: 'integer', minimum: 0 }, message: nullable('string'), publish: { type: 'boolean' },
    } }),
    responses: { 201: json('The revert revision', { type: 'object', properties: { page: ref('Page'), revision: ref('Revision'), published: { type: 'boolean' } } }), ...errors() },
});
route('post', '/pages/{id}/media', {
    operationId: 'attachMedia', summary: 'Attach an OpenVibe.Media object to a page', tags: ['media'], security: PERSON, parameters: [PAGE],
    description: 'wiki.page.create. The caller must be able to read the object in Media; a private object is refused (409).',
    requestBody: body({ type: 'object', required: ['media_id'], properties: { media_id: str(), alt: nullable('string'), caption: nullable('string') } }),
    responses: { 201: json('The attachment', { type: 'object', properties: { attachment: ref('Attachment') } }), ...errors() },
});
route('post', '/pages/{id}/media/verify', {
    operationId: 'verifyMedia', summary: 'Re-check every attachment against Media', tags: ['media'], security: PERSON, parameters: [PAGE],
    description: 'wiki.page.create. Editors only.',
    responses: { 200: json('One result per attachment', { type: 'object', properties: { results: arrayOf({ type: 'object' }) } }), ...errors() },
});
route('put', '/pages/{id}/watch', {
    operationId: 'watchPage', summary: 'Watch (or stop watching) a page', tags: ['pages'], security: PERSON, parameters: [PAGE],
    description: 'People only: a service token cannot watch.',
    requestBody: body({ type: 'object', properties: { watching: { type: 'boolean', default: true } } }, false),
    responses: { 200: json('The new state', { type: 'object', properties: { watching: { type: 'boolean' } } }), ...errors() },
});
route('post', '/proposals', {
    operationId: 'createProposal', summary: 'Propose a revision from a generation run', tags: ['proposals'], security: PERSON,
    description: 'wiki.revision.propose. The proposal waits for a person\'s review (2026 ADR: AI output is never published unreviewed).',
    requestBody: body({ type: 'object', required: ['space', 'body', 'workflow'], properties: {
        space: str({ description: 'The space slug' }), page_id: nullable('string'), title: str({ maxLength: 200 }), body: str({ maxLength: 200000 }),
        summary: str({ maxLength: 300 }), infobox, citations: arrayOf(citation),
        workflow: { type: 'object', required: ['id'], properties: { id: str(), run_id: str(), version: nullable('string'), model: nullable('string') } },
        stub_provider: { type: 'boolean' }, expected_revision: { type: 'integer', minimum: 0 }, note: nullable('string'),
    } }),
    responses: { 201: json('The proposal, its page and revision', { type: 'object', properties: { proposal: { type: 'object' }, page: ref('Page'), revision: ref('Revision') } }), ...errors() },
});
route('get', '/proposals/{id}', {
    operationId: 'getProposal', summary: 'A proposal\'s state', tags: ['proposals'], security: PERSON, parameters: [PROPOSAL],
    description: 'Editors of the space, or the service that proposed it.',
    responses: { 200: json('The proposal', { type: 'object', properties: { proposal: { type: 'object' } } }), ...errors([400, 401, 404, 429]) },
});
route('post', '/proposals/{id}/review', {
    operationId: 'reviewProposal', summary: 'Approve or reject a proposal', tags: ['proposals'], security: PERSON, parameters: [PROPOSAL],
    description: 'wiki.revision.publish. An approved proposal publishes unless publish is false.',
    requestBody: body({ type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['approved', 'rejected'] }, note: nullable('string'), publish: { type: 'boolean', default: true } } }),
    responses: { 200: json('The reviewed proposal', { type: 'object', properties: { proposal: { type: 'object' }, published: { type: 'boolean' } } }), ...errors() },
});
route('get', '/search', {
    operationId: 'search', summary: 'Search published pages', tags: ['search'], security: ANONYMOUS, parameters: [
        query('q', str({ maxLength: 200 }), 'Required'), query('space', str(), 'Limit to one space slug'), query('limit', { type: 'integer', minimum: 1, maximum: 100 })],
    description: 'wiki.search.query. A substring scan of the text of every page the caller can read.',
    responses: { 200: json('Matching pages, newest first', { type: 'object', properties: { results: arrayOf(ref('SearchResult')) } }), ...errors([400, 401, 429]) },
});
route('post', '/vibes', {
    operationId: 'startVibe', summary: 'Generate a whole wiki on a topic (202, then poll)', tags: ['vibes'], security: PERSON,
    description: 'wiki.space.create. A person only; answers 503 when generated wikis are not configured here.',
    requestBody: body({ type: 'object', required: ['topic'], properties: {
        topic: str({ maxLength: 300 }), size: { type: 'string', enum: ['quick', 'standard', 'big'], default: 'standard' },
        visibility: { type: 'string', enum: ['public', 'private'], default: 'public' }, lang: str({ default: 'en' }),
    } }),
    responses: { 202: json('The generated wiki, its space and where to watch progress', { type: 'object', properties: { vibe: { type: 'object' }, space: ref('Space'), progress_url: str() } }), 503: problem, ...errors() },
});
route('get', '/vibes', {
    operationId: 'listVibes', summary: 'The caller\'s generated wikis', tags: ['vibes'], security: PERSON,
    responses: { 200: json('Generated wikis', { type: 'object', properties: { vibes: arrayOf({ type: 'object' }) } }), 503: problem, ...errors([400, 401, 429]) },
});
route('get', '/vibes/{vibe}', {
    operationId: 'getVibe', summary: 'A generated wiki\'s progress', tags: ['vibes'], security: PERSON, parameters: [VIBE],
    description: 'wiki.page.read. status, pages written and the wiki\'s address.',
    responses: { 200: json('The generated wiki', { type: 'object', properties: { vibe: { type: 'object' } } }), 503: problem, ...errors([400, 401, 404, 429]) },
});

function openapi() {
    return {
        openapi: '3.1.0',
        info: {
            title: 'OpenVibe.Wiki API',
            version: pkg.version,
            description: pkg.description,
            license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
            contact: { name: 'OpenVibers', url: 'https://github.com/OpenVibers/OpenVibe.Wiki', email: 'contact@openvibe.network' },
        },
        servers: [{ url: SITE }],
        tags: ['spaces', 'pages', 'revisions', 'citations', 'media', 'proposals', 'search', 'vibes'].map((name) => ({ name })),
        components: {
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A Network user JWT (people) or a service token for audience openvibe.wiki carrying the route\'s capability, acting for the person named in X-OV-Subject' },
                cookie: { type: 'apiKey', in: 'cookie', name: 'ov_token', description: 'The browser session: the same Network user JWT as a host-only cookie' },
            },
            schemas: {
                Space: { type: 'object', required: ['id', 'slug', 'name', 'kind', 'visibility'], properties: {
                    id: str({ pattern: '^spc_' }), slug: str(), name: str(), description: nullable('string'),
                    kind: { type: 'string', enum: ['official', 'user'] },
                    visibility: { type: 'string', enum: ['public', 'members', 'vip', 'private'] },
                    created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }),
                } },
                Page: { type: 'object', required: ['id', 'space', 'slug', 'title', 'state'], properties: {
                    id: str({ pattern: '^pg_' }), space: str({ description: 'The space slug' }), slug: str(), title: str(),
                    parent_id: nullable('string'), state: { type: 'string', enum: ['draft', 'published', 'deleted'] },
                    visibility: { type: 'string', enum: ['public', 'members', 'vip', 'private'] }, noindex: { type: 'boolean' },
                    published_revision: nullable('integer'), published_at: nullable('string', { format: 'date-time' }),
                    revision_published_at: nullable('string', { format: 'date-time' }), updated_at: str({ format: 'date-time' }), url: str(),
                } },
                PageTree: { allOf: [ref('Page'), { type: 'object', properties: { children: arrayOf(ref('PageTree')) } }] },
                Revision: { type: 'object', properties: {
                    number: { type: 'integer' }, id: str(), kind: str({ description: 'edit, revert or import' }),
                    parent_number: nullable('integer'), reverted_to: nullable('integer'), title: str(), summary: nullable('string'),
                    infobox, body: str(), authorship: nullable('object', { description: 'The authorship record (mode, tool, reviewed)' }),
                    author: nullable('string'), message: nullable('string'), created_at: str({ format: 'date-time' }),
                } },
                RevisionSummary: { allOf: [ref('Revision'), { type: 'object', properties: {
                    body: { type: 'null', description: 'Never sent in a history listing' }, published: { type: 'boolean' },
                    citation_count: { type: 'integer' }, proposal: nullable('object', { description: '{ id, status } when the revision came from a proposal' }),
                } }] },
                Citation: { type: 'object', properties: {
                    id: str(), revision: { type: 'integer' }, url: nullable('string'), title: nullable('string'),
                    source_item_id: nullable('string'), retrieved_at: nullable('string', { format: 'date-time' }),
                    quote: nullable('object', { properties: { text: str() } }), license_note: nullable('string'),
                    carried_from: nullable('integer'), attached_by: nullable('string'), attached_at: str({ format: 'date-time' }),
                } },
                Attachment: { type: 'object', properties: {
                    id: str(), media_id: str(), alt: nullable('string'), caption: nullable('string'),
                    state: str({ description: 'ok or broken' }), broken_reason: nullable('string'),
                    checked_at: nullable('string', { format: 'date-time' }), attached_by: nullable('string'),
                } },
                Role: { type: 'object', properties: { subject: str(), role: { type: 'string', enum: ['owner', 'editor', 'viewer'] }, granted_by: nullable('string'), granted_at: str({ format: 'date-time' }) } },
                CreatedPage: { type: 'object', properties: { page: ref('Page'), revision: ref('Revision'), created: { type: 'boolean' }, citations: arrayOf(ref('Citation')) } },
                RevisionView: { type: 'object', properties: { revision: ref('Revision'), citations: arrayOf(ref('Citation')), infobox } },
                PageView: { type: 'object', properties: {
                    page: ref('Page'), revision: ref('Revision'), citations: arrayOf(ref('Citation')), infobox,
                    attachments: arrayOf(ref('Attachment')),
                    links: arrayOf({ type: 'object', properties: { space: str(), slug: str(), label: nullable('string') } }),
                    indexability: { type: 'object', properties: { indexable: { type: 'boolean' }, reasons: arrayOf(str()) } },
                    discussion_thread: nullable('string'),
                } },
                SearchResult: { allOf: [ref('Page'), { type: 'object', properties: { summary: nullable('string') } }] },
            },
        },
        paths: { ...Object.fromEntries(Object.entries(PATHS).map(([p, item]) => [MOUNT + p, item])) },
    };
}

/** The documented routes as "METHOD /api/v1/path": what the router must mount. */
function routes() {
    return Object.entries(PATHS).flatMap(([p, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${MOUNT}${p}`)).sort();
}

/** Serve GET /openapi.json here; GET /api/v1/openapi.json redirects to it (308). */
function mount(app, document = openapi()) {
    const send = (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json; charset=utf-8').send(JSON.stringify(document));
    };
    app.get('/openapi.json', send);
    app.get('/api/v1/openapi.json', (_req, res) => res.redirect(308, '/openapi.json'));
}

module.exports = { openapi, routes, mount, MOUNT };
