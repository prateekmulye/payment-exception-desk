import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const portfolio = 'https://prateekmulye.dev/';
const applications = {
  'payment-exception-desk': { name: 'Payment Exception Desk', origin: 'https://payments.prateekmulye.dev/' },
  'load-review': { name: 'Load Review', origin: 'https://energy.prateekmulye.dev/' },
  'caption-review': { name: 'Caption Review', origin: 'https://captions.prateekmulye.dev/' },
};
// These checks read our small, controlled HTML documents; this is not a general HTML parser.
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(([, key, , value]) => [key.toLowerCase(), value]));
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(match => attributes(match[0]));
const one = (items, message) => { assert.equal(items.length, 1, message); return items[0]; };

export async function checkApp(directory) {
  directory = resolve(directory);
  const slug = basename(directory), app = applications[slug];
  assert(app, `Unknown application directory: ${slug}`);
  const read = name => readFile(join(directory, name), 'utf8');
  const [html, headers, robots, sitemap, llms] = await Promise.all(['index.html', '_headers', 'robots.txt', 'sitemap.xml', 'llms.txt'].map(read));
  const head = one([...html.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head>/gi)], `${slug}: exactly one document head`)[1];
  const title = one([...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)], `${slug}: exactly one document title`)[1].trim();
  assert(title.includes(app.name), `${slug}: document title must name the application`);
  const links = tags(html, 'link'), meta = tags(html, 'meta');
  const metadata = key => one(meta.filter(m => m.name === key || m.property === key), `${slug}: exactly one ${key}`).content;
  assert.equal(one(links.filter(l => l.rel === 'canonical'), `${slug}: exactly one canonical`).href, app.origin);
  assert.equal(metadata('author'), 'Prateek Mulye');
  assert.equal(metadata('og:site_name'), app.name);
  assert.equal(metadata('og:url'), app.origin);
  assert.equal(metadata('twitter:card'), 'summary_large_image');
  assert(metadata('description').trim(), `${slug}: missing description`);
  assert(!/\b(?:noindex|none|nofollow)\b/i.test(metadata('robots')), `${slug}: page indexing disabled`);
  assert(!/X-Robots-Tag:[^\n]*(?:noindex|none|nofollow)/i.test(headers), `${slug}: header indexing disabled`);
  const schemas = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match => attributes(match[1]).type === 'application/ld+json');
  const schemaText = one(schemas, `${slug}: exactly one JSON-LD application`)[2];
  const schema = JSON.parse(schemaText);
  assert.equal(schema['@context'], 'https://schema.org');
  assert.equal(schema['@type'], 'SoftwareApplication');
  assert.equal(schema['@id'], `${app.origin}#application`);
  assert.equal(schema.name, app.name);
  assert.equal(schema.url, app.origin);
  assert.equal(schema.isAccessibleForFree, true);
  assert.deepEqual(schema.author, { '@type': 'Person', name: 'Prateek Mulye', url: portfolio });
  assert.deepEqual(schema.offers, { '@type': 'Offer', price: '0', priceCurrency: 'USD', url: app.origin });
  assert.equal(schema.sameAs, `https://github.com/prateekmulye/${slug}`);
  assert(!/"(?:aggregateRating|ratingValue|ratingCount|reviewCount|review|reviews|award)"\s*:/.test(schemaText), `${slug}: unsupported rating/review claim`);
  const hash = createHash('sha256').update(schemaText).digest('base64');
  const scriptPolicy = one([...headers.matchAll(/(?:^|;)\s*script-src\s+([^;\n]+)/gm)], `${slug}: script-src policy`)[1];
  assert(scriptPolicy.split(/\s+/).includes(`'sha256-${hash}'`), `${slug}: JSON-LD hash missing from CSP`);
  assert(!scriptPolicy.includes("'unsafe-inline'"), `${slug}: inline execution must use an exact hash`);
  assert(/^User-agent:\s*\*\s*$/m.test(robots), `${slug}: missing crawler group`);
  assert(/^Allow:\s*\/\s*$/m.test(robots), `${slug}: missing root allow`);
  assert(!/^Disallow:\s*\/\s*$/m.test(robots), `${slug}: crawler root blocked`);
  assert(robots.split(/\r?\n/).includes(`Sitemap: ${app.origin}sitemap.xml`), `${slug}: wrong sitemap URL`);
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), [app.origin]);
  assert(llms.startsWith(`# ${app.name}\n`), `${slug}: wrong LLM document name`);
  assert(llms.includes(`](${app.origin})`) && llms.includes(`](${portfolio})`), `${slug}: LLM document links missing`);
  assert(tags(html, 'a').some(a => a.href === portfolio), `${slug}: missing visible author link`);
  const icon = one(links.filter(l => l.rel === 'icon'), `${slug}: exactly one favicon`).href;
  const logo = one(tags(html, 'img').filter(img => img.class?.split(/\s+/).includes('app-logo')), `${slug}: exactly one visible logo`).src;
  const og = metadata('og:image');
  assert.equal(og, `${app.origin}og.png`);
  assert.equal(metadata('twitter:image'), og);
  assert.equal(schema.image, og);
  for (const href of [icon, logo, og, './og.svg']) {
    const url = new URL(href, app.origin);
    assert.equal(url.origin, new URL(app.origin).origin, `${slug}: brand asset must be local`);
    assert(!url.search && !url.hash, `${slug}: asset URL must name a file`);
    const path = resolve(directory, '.' + decodeURIComponent(url.pathname));
    assert(path.startsWith(directory + sep), `${slug}: asset escapes application`);
    assert((await lstat(path)).isFile(), `${slug}: missing regular asset ${href}`);
    const bytes = await readFile(path);
    if (path.endsWith('.svg')) assert(/<svg\b/.test(bytes.toString('utf8')), `${slug}: invalid SVG ${href}`);
    else {
      assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${slug}: invalid PNG`);
      assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
      assert.equal(bytes.readUInt32BE(16), Number(metadata('og:image:width')));
      assert.equal(bytes.readUInt32BE(20), Number(metadata('og:image:height')));
    }
  }
  const ids = tags(html, '[a-z][\\w:-]*').map(tag => tag.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, `${slug}: duplicate static DOM IDs`);
  for (const id of ['validate', 'analyze', 'cancel', 'status', 'export-area']) assert(ids.includes(id), `${slug}: missing existing control ${id}`);
  console.log(`PASS ${slug}: canonical, schema/CSP, crawler files, brand assets and DOM IDs`);
}

export async function checkDiscovery(directories = Object.keys(applications).map(slug => join(root, 'apps', slug)), portfolioRoot = root) {
  for (const directory of directories) await checkApp(directory);
  if (portfolioRoot) {
    const [component, llms] = await Promise.all(['src/components/PersonalCandidate.astro', 'public/llms.txt'].map(path => readFile(join(portfolioRoot, path), 'utf8')));
    for (const app of Object.values(applications)) {
      assert(component.includes(app.origin) && llms.includes(app.origin), `${app.name}: missing portfolio return link`);
    }
    console.log('PASS portfolio: all three application links in page source and llms.txt');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = process.argv.slice(2);
  await checkDiscovery(directories.length ? directories : undefined, directories.length ? null : root);
}
