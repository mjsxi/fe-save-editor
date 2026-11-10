/* Checks the open-a-file path in index.html without a browser (jsdom): "choose files" must open the picker
   exactly once per click, and the picked file must actually load.

     node tools/test-picker.mjs [path/to/save.dmsync]     default: ../fe3h-save/<title>/save.dmsync

   Needs jsdom once:  npm install jsdom
   The bug this guards against: the file input used to sit inside a <label> inside the drop zone, so one
   click both activated the label and bubbled to the drop zone's own handler - two pickers, the second
   dismissing the first, so nothing ever loaded. Drag and drop was unaffected, which is why it looked like
   only the button was broken. */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
let JSDOM;
for (const dir of [process.env.PAGE_TEST_NODE_MODULES, path.join(process.env.HOME || '', 'node_modules'), '/opt/homebrew/lib/node_modules'].filter(Boolean)) {
  try { const m = createRequire(path.join(dir, 'noop.js'))('jsdom'); JSDOM = m.JSDOM || m; if (typeof JSDOM === 'function') break; } catch (e) { /* keep looking */ }
}
if (!JSDOM) { try { const m = require('jsdom'); JSDOM = m.JSDOM || m; } catch (e) { console.error('jsdom is not installed. Run:  npm install jsdom'); process.exit(2); } }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
let SAVE = process.argv[2];
if (!SAVE) {
  const dirs = fs.readdirSync(path.join(ROOT, '..', 'fe3h-save'), { withFileTypes: true }).filter((d) => d.isDirectory());
  SAVE = dirs.map((d) => path.join(ROOT, '..', 'fe3h-save', d.name, 'save.dmsync')).find((p) => fs.existsSync(p));
}
if (!SAVE || !fs.existsSync(SAVE)) { console.error('no save to open: ' + SAVE); process.exit(2); }

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + label + (extra ? '  · ' + extra : '')); } else { fail++; console.log('  FAIL ' + label + (extra ? '  · ' + extra : '')); } };

const dom = new JSDOM(await fs.promises.readFile(path.join(ROOT, 'index.html'), 'utf8'), {
  url: pathToFileURL(path.join(ROOT, 'index.html')).href, runScripts: 'dangerously', resources: 'usable',
  pretendToBeVisual: true, beforeParse(w) { Object.defineProperty(w, 'crypto', { value: crypto.webcrypto, configurable: true }); },
});
await new Promise((r) => { if (dom.window.document.readyState === 'complete') return r(); dom.window.addEventListener('load', r); });
const win = dom.window, doc = win.document;
const input = doc.getElementById('files'), drop = doc.getElementById('drop'), pick = doc.getElementById('pick');

ok('the page loaded with its codec', win.eval('typeof FE3H') === 'object');
ok('the file input is outside the drop zone', !!input && !drop.contains(input));
ok('no <label> wraps the file input', !!input && !doc.querySelector('label #files, label > input#files'));
let opens = 0;
input.addEventListener('click', () => { opens++; });
pick.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
ok('clicking "choose files" opens the picker exactly once', opens === 1, opens + ' open(s)');
opens = 0;
drop.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
ok('clicking anywhere in the drop zone opens it exactly once', opens === 1, opens + ' open(s)');
const bytes = fs.readFileSync(SAVE);
Object.defineProperty(input, 'files', { value: [new win.File([new Uint8Array(bytes)], 'save.dmsync')], configurable: true });
input.dispatchEvent(new win.Event('change', { bubbles: true }));
await new Promise((r) => setTimeout(r, 700));
ok('the picked save actually opened', doc.getElementById('editor').hidden === false && doc.querySelectorAll('#slots button.slot').length > 0,
  [...doc.querySelectorAll('#slots button.slot')].map((b) => b.textContent).join(' | '));
ok('the input is cleared, so the same file can be picked again', input.value === '');
ok('"choose files" is still there after a load', !!doc.getElementById('pick'));
const errs = [...doc.querySelectorAll('#log span.bad')].map((s) => s.textContent);   // say() strips the leading '!', so the class is what marks an error
ok('no errors in the log', errs.length === 0, errs.join(' | '));
ok('the save on disk is untouched', Buffer.compare(Buffer.from(fs.readFileSync(SAVE)), bytes) === 0);
console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' checks passed, ' + fail + ' failed.');
dom.window.close();
process.exit(fail ? 1 : 0);
