// Fails if the built dist/ (or argv[2]) contains the test-fixture marker. Run after `vite build`.
const fs = require('fs'), path = require('path');
const MARKER = 'SYNTHETIC_TEST_ONLY';
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
const hits = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.includes(MARKER) || e.name.includes('test-fixture') || fs.readFileSync(p, 'latin1').includes(MARKER)) hits.push(p);
  }
})(root);
if (hits.length) { console.error(`check:dist FAILED, fixture marker found in:\n${hits.join('\n')}`); process.exit(1); }
console.log(`check:dist ok (${root})`);
