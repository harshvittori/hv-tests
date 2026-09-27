// Scans tests/<slug>/test.json and writes tests.json for the All Tests page.
// Run: node scripts/build-manifest.mjs   (add --check to fail if tests.json is out of date)
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "tests");
const outFile = join(root, "tests.json");
const sitemapFile = join(root, "sitemap.xml");
const SITE = "https://harshvittori.github.io/hv-tests/";
const STATUSES = ["live", "coming-soon", "hidden", "moved"];
const errors = [];
const tests = [];

for (const slug of readdirSync(testsDir).sort()) {
  const dir = join(testsDir, slug);
  if (slug.startsWith("_") || slug.startsWith(".") || !statSync(dir).isDirectory()) continue;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) { errors.push(`${slug}: folder name must be lowercase-with-dashes`); continue; }

  const metaPath = join(dir, "test.json");
  if (!existsSync(metaPath)) { errors.push(`${slug}: missing test.json`); continue; }
  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, "utf8")); }
  catch (e) { errors.push(`${slug}: test.json is not valid JSON (${e.message})`); continue; }

  const status = meta.status || "live";
  if (!STATUSES.includes(status)) errors.push(`${slug}: status must be one of ${STATUSES.join(", ")}`);
  if (!meta.title) errors.push(`${slug}: test.json needs a "title"`);
  if ((status === "live" || status === "moved") && !existsSync(join(dir, "index.html"))) errors.push(`${slug}: ${status} test needs index.html`);
  if (status === "hidden" || status === "moved") continue;

  tests.push({
    slug,
    url: `tests/${slug}/`,
    title: meta.title,
    category: meta.category || "More tests",
    tagline: meta.tagline || "",
    description: meta.description || "",
    questions: meta.questions ?? null,
    minutes: meta.minutes ?? null,
    outputs: Array.isArray(meta.outputs) ? meta.outputs : [],
    status,
    order: Number.isFinite(meta.order) ? meta.order : 999,
    added: meta.added || ""
  });
}

if (errors.length) {
  console.error("Problems found:\n  " + errors.join("\n  "));
  process.exit(1);
}

tests.sort((a, b) => a.order - b.order || b.added.localeCompare(a.added) || a.title.localeCompare(b.title));
const json = JSON.stringify({ tests }, null, 2) + "\n";
// sitemap.xml for search engines: the hub plus every live test
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  [SITE, ...tests.filter(t => t.status === "live").map(t => SITE + t.url)]
    .map(u => `  <url><loc>${u}</loc></url>`).join("\n") + "\n</urlset>\n";

if (process.argv.includes("--check")) {
  const current = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  const currentMap = existsSync(sitemapFile) ? readFileSync(sitemapFile, "utf8") : "";
  if (current !== json || currentMap !== sitemap) { console.error("tests.json or sitemap.xml is out of date. Run: node scripts/build-manifest.mjs"); process.exit(1); }
  console.log(`tests.json is up to date (${tests.length} tests).`);
} else {
  writeFileSync(outFile, json);
  writeFileSync(sitemapFile, sitemap);
  console.log(`Wrote tests.json with ${tests.length} tests: ${tests.map(t => t.slug).join(", ")}`);
}
