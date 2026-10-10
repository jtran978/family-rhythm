// Supabase Edge Function: import-recipe
// Fetches a recipe page and pulls out its schema.org Recipe data (the structured copy most
// recipe sites embed for search engines): title, photo, ingredients, steps, time, servings.
// Only signed-in household logins can call it. It doesn't touch the database; the app saves the result.
//
// Deploy: Supabase dashboard > Edge Functions > Deploy a new function > Via Editor,
// name it import-recipe, paste this file, Deploy.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const MAX_BYTES = 3_000_000;
// Some sites only accept an honest bot name, others only a browser. Try honest first.
const AGENTS = [
  'Mozilla/5.0 (compatible; FamilyRhythmRecipeImporter/1.0)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
];

// Public http(s) pages only: no logins in the URL, raw IP addresses, local names or odd ports.
function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null;
  if (/(^|\.)(localhost|local|internal|lan|home)$/.test(h)) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  return u;
}

async function fetchPage(start) {
  let lastError;
  for (const agent of AGENTS) {
    try { return await fetchWith(start, agent); } catch (e) { lastError = e; if (!e.blocked) throw e; }
  }
  throw lastError;
}

async function fetchWith(start, agent) {
  let url = start;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': agent, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(10_000)
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = publicUrl(new URL(res.headers.get('location'), url).href);
      if (!next) throw new Error('Redirected somewhere unsafe');
      url = next;
      continue;
    }
    if (!res.ok) {
      const err = new Error(res.status === 403 ? 'the site blocks apps from reading it' : `the site answered ${res.status}`);
      err.blocked = [401, 403, 406, 429, 503].includes(res.status);
      throw err;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { reader.cancel(); break; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size > MAX_BYTES ? MAX_BYTES : size);
    let at = 0;
    for (const c of chunks) { const n = Math.min(c.length, bytes.length - at); bytes.set(c.subarray(0, n), at); at += n; }
    return { html: new TextDecoder().decode(bytes), finalUrl: url };
  }
  throw new Error('Too many redirects');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', frac13: '⅓',
  frac23: '⅔', deg: '°', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', times: '×'
};
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return m; }
  });
}
function clean(s) {
  if (s == null) return '';
  let t = String(s);
  t = decode(decode(t)); // some sites double-encode
  return t.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t ]+/g, ' ')
    .replace(/\(\s*,\s*/g, '(').replace(/\(\(([^()]*)\)\)/g, '($1)')
    .split('\n').map(x => x.trim()).filter(Boolean).join('\n').trim();
}
const list = x => (x == null ? [] : Array.isArray(x) ? x : [x]);
const typesOf = n => list(n?.['@type']).map(t => String(t).toLowerCase());

function findRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipe(n, depth + 1); if (r) return r; }
    return null;
  }
  if (typesOf(node).includes('recipe')) return node;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const r = findRecipe(node[k], depth + 1);
    if (r) return r;
  }
  return null;
}

function jsonLdBlocks(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    for (const attempt of [raw, raw.replace(/[\u0000-\u001f]+/g, ' ')]) {
      try { out.push(JSON.parse(attempt)); break; } catch { /* try the next cleanup */ }
    }
  }
  return out;
}

// Instructions come as a string, a list of strings, HowToSteps, or HowToSections of steps.
// Returns [{ name, steps: [...] }], with name null for steps outside any section.
function instructionSections(x) {
  const sections = [];
  let loose = [];
  const walk = n => {
    if (n == null) return;
    if (typeof n === 'string') { clean(n).split('\n').forEach(s => s && loose.push(s)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== 'object') return;
    if (typesOf(n).includes('howtosection')) {
      if (loose.length) { sections.push({ name: null, steps: loose }); loose = []; }
      const outer = loose;
      loose = [];
      walk(n.itemListElement);
      sections.push({ name: clean(n.name).replace(/:$/, '') || null, steps: loose });
      loose = outer;
      return;
    }
    if (n.text) { const t = clean(n.text); if (t) loose.push(t); }
    else if (n.itemListElement) walk(n.itemListElement);
    else if (n.name) { const t = clean(n.name); if (t) loose.push(t); }
  };
  walk(x);
  if (loose.length) sections.push({ name: null, steps: loose });
  return sections
    .map(s => ({ name: s.name ? s.name.slice(0, 120) : null, steps: s.steps.slice(0, 100).map(t => t.slice(0, 2000)) }))
    .filter(s => s.steps.length)
    .slice(0, 20);
}

function minutes(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i.exec(String(d ?? '').trim());
  if (!m) return null;
  const t = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return t > 0 ? Math.round(t) : null;
}

function httpsImage(img, base) {
  for (const i of list(img)) {
    const raw = typeof i === 'string' ? i : i?.url || i?.contentUrl;
    if (!raw) continue;
    try { const u = new URL(raw, base); if (u.protocol === 'https:') return u.href; } catch { /* skip */ }
  }
  return null;
}

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return tag ? clean(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1]) : '';
}

function parseRecipe(html, pageUrl) {
  const site = new URL(pageUrl).hostname.replace(/^www\./, '');
  let recipe = null;
  for (const block of jsonLdBlocks(html)) { recipe = findRecipe(block); if (recipe) break; }
  const pageTitle = meta(html, 'og:title') || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const pageImage = httpsImage(meta(html, 'og:image'), pageUrl);
  if (!recipe) return { found: false, title: pageTitle.slice(0, 200) || site, image_url: pageImage, site, ingredients: [], instructions: [] };

  const yields = list(recipe.recipeYield).map(clean).filter(Boolean);
  const total = minutes(recipe.totalTime) ?? (((minutes(recipe.prepTime) || 0) + (minutes(recipe.cookTime) || 0)) || null);
  return {
    found: true,
    title: (clean(recipe.name) || pageTitle || site).slice(0, 200),
    image_url: httpsImage(recipe.image, pageUrl) || pageImage,
    site,
    yields: (yields.find(y => /[a-z]/i.test(y)) || yields[0] || '').slice(0, 80) || null,
    total_minutes: total,
    ingredients: list(recipe.recipeIngredient || recipe.ingredients).map(clean).filter(Boolean).slice(0, 100).map(t => t.slice(0, 300)),
    instructions: instructionSections(recipe.recipeInstructions)
  };
}

// ---- handler ----
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  // A real signed-in user, not just the public app key.
  const who = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '' }
  });
  if (!who.ok) return json({ error: 'Please sign in again.' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Send {"url": "…"}' }, 400); }
  const url = publicUrl(body?.url);
  if (!url) return json({ error: 'That link can’t be imported.' }, 400);

  try {
    const { html, finalUrl } = await fetchPage(url);
    return json(parseRecipe(html, finalUrl.href));
  } catch (e) {
    return json({ error: `Couldn’t read that page (${e instanceof Error ? e.message : 'unknown error'}).` }, 502);
  }
});
