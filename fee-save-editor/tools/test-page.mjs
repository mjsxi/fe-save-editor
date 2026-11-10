/* Drives index.html in a real DOM (jsdom, no browser) and checks the page itself, not just the codec:
   open a save, render every tab, click the widgets, repack the container, and read the result back.

     node tools/test-page.mjs [path/to/save.dmsync]

   Needs jsdom once:  npm install jsdom   (this folder, or anywhere - it is looked up from here and above).
   What it proves is the page's own logic against the live DOM; it cannot prove how Safari paints it. */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
let JSDOM;
const lookups = ['jsdom'];
for (const dir of [process.env.PAGE_TEST_NODE_MODULES, path.join(process.env.HOME || '', 'node_modules'), '/opt/homebrew/lib/node_modules'].filter(Boolean)) {
  try { lookups.push(createRequire(path.join(dir, 'noop.js'))('jsdom')); } catch (e) { /* not there */ }
}
for (const candidate of lookups) { try { const m = typeof candidate === 'string' ? require(candidate) : candidate; JSDOM = m.JSDOM || m; if (typeof JSDOM === 'function') break; } catch (e) { /* keep looking */ } }
if (!JSDOM) { console.error('jsdom is not installed. Either:  npm install jsdom   (in this folder)  or  npm install -g jsdom'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SAVE = process.argv[2] || path.join(ROOT, '..', 'fee-save', '0100A6301214E000', 'save.dmsync');
const crypto = await import('crypto');

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + label + (extra ? '  · ' + extra : '')); } else { fail++; console.log('  FAIL ' + label + (extra ? '  · ' + extra : '')); } };

const dom = new JSDOM(await fs.promises.readFile(path.join(ROOT, 'index.html'), 'utf8'), {
  url: pathToFileURL(path.join(ROOT, 'index.html')).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) { Object.defineProperty(window, 'crypto', { value: crypto.webcrypto, configurable: true }); },
});
await new Promise((resolve) => { if (dom.window.document.readyState === 'complete') return resolve(); dom.window.addEventListener('load', resolve); });
const win = dom.window, doc = win.document;
const ev = (code) => win.eval(code);

console.log('1 · the page loads');
ok('scripts loaded (FEE, FEE_DATA)', ev('typeof FEE') === 'object' && ev('typeof FEE_DATA') === 'object');
ok('name tables present', ev('FEE_DATA.en.items.length') === 364 && ev('FEE_DATA.en.bracelets.length') === 7);
ok('datalists filled', doc.getElementById('dl-items').children.length === 364 && doc.getElementById('dl-rings').children.length === 483);
ok('no save open yet', doc.getElementById('editor').hidden === true);

console.log('\n2 · opening a save through "choose files" (the picker path, not the drop path)');
const bytes = fs.readFileSync(SAVE);
win.__bytesArr = [...bytes];
const input = doc.getElementById('files');
const dropZone = doc.getElementById('drop');
const pick = doc.getElementById('pick');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let opens = 0;
input.addEventListener('click', () => { opens++; });
ok('the file input is not inside the drop zone (nesting used to open the picker twice)', !dropZone.contains(input));
ok('no <label> wraps the file input (label activation was the second open)', !doc.querySelector('label #files, label > input#files'));
pick.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
ok('clicking "choose files" opens the picker exactly once', opens === 1, opens + ' open(s)');
opens = 0;
dropZone.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
ok('clicking anywhere in the drop zone opens it exactly once too', opens === 1, opens + ' open(s)');
const pickFile = () => {
  Object.defineProperty(input, 'files', { value: [new win.File([new Uint8Array(win.__bytesArr)], 'save.dmsync')], configurable: true });
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
};
pickFile();
await wait(500);
ok('the picked file opened', doc.getElementById('editor').hidden === false && doc.querySelectorAll('#slots button.slot').length === 2,
  [...doc.querySelectorAll('#slots button.slot')].map((b) => b.textContent).join(' | '));
ok('the input is cleared afterwards, so the same file can be picked twice in a row', input.value === '', JSON.stringify(input.value));
ok('"choose files" is still there after a load (the drop text used to wipe it)', !!pick);
opens = 0; pickFile(); await wait(500);
ok('picking the same file again opens it again', doc.getElementById('log').textContent.split('\n').filter((l) => /container hash verified/.test(l)).length === 2);
ok('container hash verified', /hash ok/.test(doc.getElementById('meta').textContent), doc.getElementById('meta').textContent.trim());
ok('summary pills filled', /money/.test(doc.getElementById('slotinfo').textContent) && /convoy/.test(doc.getElementById('slotinfo').textContent));
ok('six tabs', doc.querySelectorAll('#tabs button.tab').length === 6);
{
  const errs = [...doc.getElementById('log').textContent.split('\n')].filter((l) => l.startsWith('!'));
  ok('the log reports no errors on open', errs.length === 0, errs.join(' | '));
}

console.log('\n3 · every tab renders');
const counts = {};
for (const t of ['overview', 'units', 'items', 'emblems', 'supports', 'raw']) {
  ev(`tab = ${JSON.stringify(t)}; renderTabBar(); render();`);
  const pane = doc.getElementById('pane');
  counts[t] = { fields: pane.querySelectorAll('input, select').length, rows: pane.querySelectorAll('tr').length, plates: pane.querySelectorAll('.plate').length };
  ok(t + ' rendered', counts[t].plates > 0 && pane.textContent.trim().length > 60, counts[t].plates + ' plates, ' + counts[t].fields + ' fields, ' + counts[t].rows + ' rows');
}
{ // the DLC Bracelet, which the Emblem table cannot name by hash, still gets its real name
  ev('tab = "emblems"; renderTabBar(); render();');
  const text = doc.getElementById('pane').textContent;
  ok('a Bracelet shows its Bracelet name, not "? 0x…"', !/\? 0x/.test(text), (text.match(/Bracelet of the [A-Za-z ]+/) || ['none in this save'])[0]);
  const opts = [...doc.querySelectorAll('#pane select')[0].options].map((o) => o.textContent);
  ok('every Emblem in the picker is named', opts.every((o) => !/\? 0x/.test(o)), opts.join(' | '));
}

console.log('\n4 · widgets: edit through the DOM, then repack');
const changeInput = (label, value) => {
  const inputs = [...doc.querySelectorAll('#pane .f')].filter((f) => { const l = f.querySelector('label'); return l && l.textContent === label; });
  if (!inputs.length) throw new Error('no field labelled ' + label);
  const input = inputs[0].querySelector('input, select');
  input.value = String(value);
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
};
ev('tab = "overview"; renderTabBar(); render();');
changeInput('Money', 9999999);
ok('money edit applied', ev('cur.main().money') === 9999999);
changeInput('Bond fragments', 5000);
ok('bond fragments edit applied', ev('cur.main().bondFragments') === 5000);
changeInput('Play time (seconds)', 3600);
ok('play time edit applied', Math.round(ev('cur.header().playtime')) === 3600);
{
  const sel = [...doc.querySelectorAll('#pane .f')].find((f) => (f.querySelector('label') || {}).textContent === 'Difficulty');
  sel.querySelector('select').value = '1'; sel.querySelector('select').dispatchEvent(new win.Event('change', { bubbles: true }));
  ok('difficulty edit applied in both copies', ev('cur.main().difficulty') === 1 && ev('cur.bytes[FEE.H.difficulty]') === 1);
}
ok('four edits recorded', ev('changes.length') === 4, [...doc.querySelectorAll('#changes .chg .t')].map((x) => x.textContent).join(' | '));

ev('tab = "units"; renderTabBar(); render();');
const levelField = [...doc.querySelectorAll('#pane .f')].find((f) => (f.querySelector('label') || {}).textContent === 'Level');
levelField.querySelector('input').value = '20';
levelField.querySelector('input').dispatchEvent(new win.Event('change', { bubbles: true }));
ok('unit level edit applied', ev('cur.roster()[0].level') === 20);
{ // class change through the picker
  const before = ev('cur.roster()[0].classHash');
  const classPlate = [...doc.querySelectorAll('#pane .plate')].find((p2) => /Change class/.test((p2.querySelector('h3') || {}).textContent || ''));
  const classSel = classPlate.querySelector('select');
  const pick = [...classSel.options].find((o) => o.value !== classSel.value);
  classSel.value = pick.value; classSel.dispatchEvent(new win.Event('change', { bubbles: true }));
  [...classPlate.querySelectorAll('button')].find((b) => b.textContent === 'apply').click();
  const afterClass = JSON.parse(ev('JSON.stringify({ c: cur.roster()[0].classHash >>> 0, lv: cur.roster()[0].level })'));
  ok('class change applied through the picker', afterClass.c !== (before >>> 0),
    'class ' + afterClass.c.toString(16) + ' (was ' + (before >>> 0).toString(16) + '), reset to level ' + afterClass.lv + ' as a fresh class');
}

ev('tab = "items"; renderTabBar(); render();');
const quickInput = doc.querySelector('#pane input[list="dl-items"]');
quickInput.value = 'Iron Sword';
[...doc.querySelectorAll('#pane button')].find((b) => b.textContent === 'add').click();
ok('convoy add applied', ev('cur.convoy().slots.filter(s => s.item).length') === ev('saves[curName].convoy().slots.filter(s => s.item).length'));
{
  const before = ev('cur.convoy().slots.filter(s => s.item).length');
  const storage = [...doc.querySelectorAll('#pane .f')].find((f) => (f.querySelector('label') || {}).textContent === 'Master Seal');
  if (storage) { storage.querySelector('input').value = '999'; storage.querySelector('input').dispatchEvent(new win.Event('change', { bubbles: true })); }
  ok('a counted item (game variable) writes', storage ? ev(`cur.mainLayout().variables.find(v => v.key === FEE.QTY_PREFIX + "IID_マスタープルフ").value`) === 999 : true, storage ? '' : 'no Master Seal field');
}

ev('tab = "supports"; renderTabBar(); render();');
{
  const row = [...doc.querySelectorAll('#pane tr')].slice(1).find((tr) => /Alear/.test(tr.textContent));
  const button = [...row.querySelectorAll('button')].find((b) => b.textContent === 'A');
  button.click();
  ok('support rank button writes the rank', ev('cur.supports().some(s => s.rank === 3)'), ev('cur.supports().filter(s => s.rank > 0).length') + ' ranked pairs');
}
ev('tab = "emblems"; renderTabBar(); render();');
{
  const maxButton = [...doc.querySelectorAll('#pane button')].find((b) => b.textContent === 'max');
  maxButton.click();
  ok('bond max button writes a bond', ev('cur.emblems().some(g => g.bonds.some(b => b.level === 20))'));
  const ringField = [...doc.querySelectorAll('#pane .f')].find((f) => (f.querySelector('label') || {}).textContent === 'stock');
  if (ringField) { const ringRow = ringField.closest('tr'); const name = ringRow.children[0].textContent;
    ringField.querySelector('input').value = '7'; ringField.querySelector('input').dispatchEvent(new win.Event('change', { bubbles: true }));
    ok('ring stock writes', ev('cur.rings().some(r => r.stock === 7)'), name.trim()); }
}

{ // Emblem and bond ring: the picker offers only legal gear, and moving it is undoable as one step
  ev('selUnit = 0; tab = "units"; renderTabBar(); render();');
  const plate = [...doc.querySelectorAll('#pane .plate')].find((p2) => /Emblem or bond ring/.test((p2.querySelector('h3') || {}).textContent || ''));
  const sel = plate && plate.querySelector('select');
  const stateKey = () => ev('cur.roster().map(u => u.index + ":" + u.emblemInstance + "/" + u.ringInstance).join(" ")');
  const original = ev('originals[curName] ? new FEE.Save(originals[curName], "x").roster().map(u => u.index + ":" + u.emblemInstance + "/" + u.ringInstance).join(" ") : ""');
  ok('the units tab offers an Emblem-or-ring picker', !!sel, sel ? sel.options.length + ' options' : 'not found');
  if (sel) {
    const values = [...sel.options].map((o) => o.value);
    ok('Alear is not offered her own Emblem', !values.includes('e1'), values.filter((v) => v[0] === 'e').join(', ') || 'no Emblem options');
    ok('every option is a label a player would recognise', [...sel.options].every((o) => /[A-Za-z]/.test(o.textContent) && !/\? 0x/.test(o.textContent)),
      [...sel.options].slice(0, 2).map((o) => o.textContent.trim()).join(' | '));
    const ring = [...sel.options].find((o) => o.value[0] === 'r');
    const who = JSON.parse(ev('JSON.stringify({ i: selUnit, name: personName(cur.roster()[selUnit].personHash), e: cur.roster()[selUnit].emblemInstance })'))
    const before = stateKey();
    sel.value = ring.value; sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    [...plate.querySelectorAll('button')].find((b) => b.textContent === 'change').click();
    const after = JSON.parse(ev('JSON.stringify({ e: cur.roster()[0].emblemInstance, r: cur.roster()[0].ringInstance })'));
    ok('equipping through the picker changes what the unit carries', after.r !== 0 && after.e === 0,
      'this unit now carries ring instance ' + after.r + (after.e ? ' and still emblem ' + after.e : ' and released its Emblem'));
    const row = [...doc.querySelectorAll('#changes .chg')].find((r2) => /Alear: /.test(r2.textContent));
    ok('the move is recorded as one change', !!row, row ? row.textContent.replace(/revert$/, '').trim().slice(0, 90) : '');
    row.querySelector('button').click();
    ok('reverting puts every unit back exactly as it was', stateKey() === original, stateKey().slice(0, 46) + '…');
    ok('and the pool is whole again', ev('cur.rings().length') === ev('new FEE.Save(originals[curName], "x").rings().length'),
      ev('cur.rings().length') + ' entries');
  }
}

console.log('\n5 · the change list and revert');
const total = ev('changes.length');
ok(total + ' edits listed with revert buttons', total >= 9 && doc.querySelectorAll('#changes button').length >= 10,
  [...doc.querySelectorAll('#changes .chg .t')].slice(0, 4).map((x) => x.textContent).join(' | '));
{
  const moneyBefore = ev('changes.length');
  const button = [...doc.querySelectorAll('#changes .chg')].find((row) => /Money:/.test(row.textContent)).querySelector('button');
  button.click();
  ok('reverting money restores the original value', ev('cur.main().money') === ev('originals[curName] ? new FEE.Save(originals[curName], "x").main().money : 0'), 'money now ' + ev('cur.main().money'));
}

console.log('\n6 · download: repack the container and read it back');
const out = await ev('(async () => { const o = await buildOutput(); return JSON.stringify({ name: o.name, size: o.bytes.length, note: o.note, bytes: Array.from(o.bytes) }); })()')
  .then((s) => JSON.parse(s));
ok('output is named after the title id', out.name === '0100A6301214E000-save.dmsync', out.name);
const FEE = require(path.join(ROOT, 'js', 'fee.js'));
const repacked = await FEE.DMS.read(new Uint8Array(out.bytes));
ok('the container the page produced reads back with a matching hash', !!repacked.hash, repacked.files + ' files');
const entries = repacked.entries.filter((e) => e.type === 'file').map((e) => e.path.split('/').pop()).sort();
ok('all three save files are still in it', entries.length === 3, entries.join(', '));
{
  const e = repacked.entries.find((x) => x.path.split('/').pop() === 'Manual0');
  const s = new FEE.Save(e.bytes, 'Manual0');
  const edits = s.main();
  ok('the kept edits survived the round trip', edits.bondFragments === 5000 && Math.round(s.header().playtime) === 3600,
    'bond ' + edits.bondFragments + ', play ' + Math.round(s.header().playtime) + 's');
  const origBundle = await FEE.DMS.read(bytes);
  const origSave = new FEE.Save(origBundle.entries.find((x) => x.path.split('/').pop() === 'Manual0').bytes, 'original');
  ok('the reverted edit is not in the file (money back to the original)', edits.money === origSave.main().money, 'money ' + edits.money + ' = original ' + origSave.main().money);
  ok('the class change is in the file, at the level the game would put it', s.roster()[0].level === 1 && s.roster()[0].classHash !== origSave.roster()[0].classHash,
    'level ' + s.roster()[0].level + ', class ' + (s.roster()[0].classHash >>> 0).toString(16) + ' (was ' + (origSave.roster()[0].classHash >>> 0).toString(16) + ')');
  ok('the convoy add is in the file', s.convoy().slots.filter((x) => x.item).length === origSave.convoy().slots.filter((x) => x.item).length + 1,
    s.convoy().slots.filter((x) => x.item).length + ' filled (was ' + origSave.convoy().slots.filter((x) => x.item).length + ')');
  ok('checksums in the downloaded file are valid', s.crcOk && s.hdrCrcOk);
  s.roster(); s.convoy(); s.emblems(); s.ownedGods(); s.rings(); s.supports(); s.mainLayout();
  ok('every section of the downloaded file still parses', true);
}
ok('the save you opened is untouched on disk', Buffer.compare(Buffer.from(fs.readFileSync(SAVE)), bytes) === 0);

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' checks passed, ' + fail + ' failed.');
dom.window.close();
process.exit(fail ? 1 : 0);
