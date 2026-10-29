'use strict';
// What openvibe.wiki tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public wiki pages (the home, a wiki's page tree and
// its articles), the JSON API under /api/v1 with its OpenAPI document, llms.txt/llms-full.txt and the sitemap.
// No separate documentation page is published, so none is named.
module.exports = {
    id: 'wiki',
    name: 'OpenVibe.Wiki',
    purpose: 'Wikis with page trees, immutable revision history, citations attached to the revision that used them, infoboxes and internal links, and a discussion thread on every page.',
    home: 'https://openvibe.wiki',
    site: 'openvibe.wiki',
    api: '/api/v1',
    openapi: '/openapi.json',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: 'The public pages are not limited by the app; /api/v1 is limited to 300 requests a minute per address, search to 60 a minute and sign-in attempts to 60 a quarter of an hour',
    },
};
