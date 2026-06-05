/**
 * Publish the static public results site.
 *   npm run publish
 * Reads results.json (+ optional roster.csv) and writes public/results.html —
 * a single self-contained file you can host anywhere.
 */
import { writeSite } from "./site.js";

const path = writeSite();
console.log(`  📄 Published results site -> ${path}`);
console.log(`     Host this file anywhere (GitHub Pages, Netlify, S3, …) — it has no dependencies.`);
