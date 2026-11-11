'use strict';
// An empty wiki space is a kit empty state, not a bare muted line, and the actions that write the first page
// are kit buttons (openvibe-shared, 4.179.0+). The space route loads kit.css so the state is styled.
const assert = require('assert');
const views = require('../server/render/views');
const fs = require('fs');
const path = require('path');

const space = { id: 's1', slug: 'demo', name: 'Demo wiki', kind: 'community', visibility: 'public', description: '' };
const edit = String(views.spacePage({ space, tree: [], canEdit: true, canManage: true, proposals: [] }));
assert.ok(edit.includes('class="ovk-empty"'), 'the shared kit empty state');
assert.ok(edit.includes('No pages yet'), 'it says what is empty');
assert.ok(edit.includes('Write the first page'), 'the next action is named');
assert.ok(/class="ovk-btn[^"]*"[^>]*href="\/s\/demo\/new"/.test(edit), 'and is a kit button');
assert.ok(/class="ovk-btn[^"]*"[^>]*href="\/s\/demo\/import"/.test(edit), 'Import pages is a kit button too');
assert.ok(/class="ovk-btn[^"]*"[^>]*href="\/s\/demo\/settings"/.test(edit), 'Wiki settings is a kit button too');

const readOnly = String(views.spacePage({ space, tree: [], canEdit: false, canManage: false, proposals: [] }));
assert.ok(readOnly.includes('class="ovk-empty"') && readOnly.includes('No pages yet'), 'a reader sees the state');
assert.ok(!readOnly.includes('Write the first page'), 'with no action they cannot take');

const pages = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'pages.js'), 'utf8');
assert.ok(/styles: \['kit\.css'\]/.test(pages), 'the space page loads kit.css');

console.log('empty states: the wiki space uses kit.empty and kit.button');
