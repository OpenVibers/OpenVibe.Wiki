'use strict';
/**
 * Pictures from the web for generated wikis, fetched under openvibe-shared/egress (the network's one rule for addresses
 * someone else chose): https only, no credentials or IP literals in the URL, the connection only to public addresses
 * (egress.safeLookup checks every DNS answer inside the connection's own lookup, so an answer cannot point it inside the
 * network), at most three redirects each judged the same way, a byte cap, a timeout, and bytes that really are a JPEG,
 * PNG, GIF or WebP whatever the server says.
 */
const net = require('net');
const https = require('https');
const egress = require('openvibe-shared/egress');

const MAX_BYTES = 8 * 1024 * 1024;
const USER_AGENT = 'OpenVibeWiki/1.0 (+https://openvibe.wiki; Contact@OpenVibe.Network)';
const { isPublicAddress } = egress;

/** The picture type the first bytes show, or null. */
function sniff(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return 'image/gif';
    if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

function checkUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { throw new Error('not a URL'); }
    if (u.protocol !== 'https:') throw new Error('only https pictures are fetched');
    if (u.username || u.password) throw new Error('credentials in a URL are refused');
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw new Error('IP-literal hosts are refused');
    if (egress.isInternalName(u.hostname)) throw new Error(`${u.hostname} is not a public host name`);
    return u;
}

/** GET a picture → { bytes, mime, url } (url: where it was read after redirects). */
function fetchImage(raw, { timeoutMs = 15000, maxBytes = MAX_BYTES, signal = null, redirects = 3, lookup = egress.safeLookup } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = checkUrl(raw); } catch (err) { return reject(err); }
        const req = https.request(u, { method: 'GET', lookup, headers: { 'User-Agent': USER_AGENT, Accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' }, timeout: timeoutMs });
        const onAbort = () => { req.destroy(new Error('aborted')); };
        if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
        const done = (fn, v) => { if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', (err) => done(reject, err));
        req.on('response', (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (redirects <= 0) return done(reject, new Error('too many redirects'));
                const next = new URL(res.headers.location, u).toString();
                return fetchImage(next, { timeoutMs, maxBytes, signal, redirects: redirects - 1, lookup }).then((v) => done(resolve, v), (e) => done(reject, e));
            }
            if (res.statusCode !== 200) { res.resume(); return done(reject, new Error(`${u.hostname} answered ${res.statusCode}`)); }
            const declared = Number(res.headers['content-length'] || 0);
            if (declared > maxBytes) { res.destroy(); return done(reject, new Error('picture too large')); }
            const chunks = [];
            let n = 0;
            res.on('data', (c) => { n += c.length; if (n > maxBytes) { res.destroy(); req.destroy(); done(reject, new Error('picture too large')); } else chunks.push(c); });
            res.on('error', (err) => done(reject, err));
            res.on('end', () => {
                const bytes = Buffer.concat(chunks);
                const mime = sniff(bytes);
                if (!mime) return done(reject, new Error('not a JPEG, PNG, GIF or WebP picture'));
                done(resolve, { bytes, mime, url: u.toString() });
            });
        });
        req.end();
    });
}

module.exports = { fetchImage, sniff, isPublicAddress, checkUrl, MAX_BYTES };
