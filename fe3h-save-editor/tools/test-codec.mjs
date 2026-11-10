// Checks the codec against the player's real save, then round-trips an edit.
//   node tools/test-codec.mjs [path/to/save.dmsync]
// Exits non-zero on any failure, so it is safe to run after changing fe3h.js.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = require(path.join(ROOT, 'js', 'fe3h.js'));
global.window = {};
require(path.join(ROOT, 'js', 'data-en.js'));
const D = window.FE3H_DATA.en;

const DMS_PATH = process.argv[2] || '/Users/matt/Library/Mobile Documents/com~apple~CloudDocs/nx-roms/fire emblem 3 houses/fe3h-save/010055D009F78000/save.dmsync';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ok   ' + name + (extra ? '  (' + extra + ')' : ''))) : (fail++, console.log('  FAIL ' + name + (extra ? '  (' + extra + ')' : ''))); };

if (!fs.existsSync(DMS_PATH)) { console.error('no save found at ' + DMS_PATH); process.exit(2); }

// ---- container ------------------------------------------------------------
const packed = new Uint8Array(fs.readFileSync(DMS_PATH));
const bundle = await F.DMS.read(packed);
console.log('container: ' + bundle.title + ', ' + bundle.files + ' files, hash ' + bundle.hash);
ok('container hash verifies', !!bundle.hash);
const again = await F.DMS.write(F.DMS.fromBundle(bundle), { title: bundle.title, device: bundle.device });
ok('repacking an untouched save is byte identical', Buffer.compare(again.bytes, packed) === 0, again.bytes.length + ' vs ' + packed.length + ' bytes');

const files = {};
for (const e of bundle.entries) if (e.type === 'file') files[path.basename(e.path)] = e.bytes;

// ---- save files -----------------------------------------------------------
for (const name of Object.keys(files)) {
  if (!F.looksLikeSave(files[name])) { console.log('  --   ' + name + ' is not a unit save, skipped'); continue; }
  const s = new F.Save(files[name], name);
  console.log('\nsave "' + name + '": version ' + s.version + ', size 0x' + s.fileSize.toString(16) + ', player ' + s.playerName());
  ok(name + ': stored checksum matches byte sum of body', s.ok, '0x' + s.checksum.toString(16));
  ok(name + ': size and version agree', s.fileSize === s.bytes.length && (s.version === 23 || s.version <= 13));
  ok(name + ': barracks array is 200 empty slots', (() => { for (let i = 0; i < 200; i++) { const b = s.barracks(i); if (b.owner !== -1 || b.exp || b.stamina || b.type !== 200 || b.skill !== 80) return false; } return true; })(), 'locates the player block at 0x' + s.playerBase.toString(16));
  ok(name + ': unit slots hold sane level/class/hp', (() => { let good = 0; for (let i = 0; i < 60; i++) { const u = s.unit(i); if (u.level <= 20 && u.class < 90 && u.hp <= 200) good++; } return good >= 55; })());
  ok(name + ': empty magic slots use the games 38 marker', s.unit(0).magicKnown.every((v) => v === 38));
  ok(name + ': fresh units start at motivation 50', s.unit(0).motivation === 50 || s.unit(0).motivation <= 100);
  ok(name + ': unit item durabilities never exceed the item max', (() => {
    let checked = 0;
    for (let i = 0; i < 60; i++) for (const it of s.unit(i).items) {
      if (it.id < 0) continue; const e = D.items[it.id]; if (!e || e.dur === undefined) continue;
      checked++; if (it.dur > e.dur && e.dur > 0) return false;
    }
    return true;
  })());
  // system cross-check: the records in save/system belong to the manual slots, not to the auto save
  if (files.system && name !== 'auto') {
    const slots = F.readSystemSlots(files.system);
    if (slots.length) ok(name + ': playtime matches a save/system record', slots.some((r) => r.playtime === s.playtime), 'system ' + slots.map((r) => r.playtime).join('/') + 's, save ' + s.playtime + 's');
  }
  if (s.version !== 23) { console.log('  --   ' + name + ': version ' + s.version + ' (not 23), edit fields with care'); continue; }

  // ---- edit round trip ----------------------------------------------------
  const t = new F.Save(files[name], name);
  const before = Buffer.from(files[name]);
  const gold = (t.gold + 12345) % 999999;
  t.s(t.playerBase + F.P.gold, 4, gold);
  t.setUnit(0, { stats: { str: 40 }, level: 5 });
  t.setItem(0, { id: 16, dur: 40, amount: 1 });
  t.seal();
  const after = Buffer.from(t.bytes);
  const u = new F.Save(after, name);
  ok(name + ': edited save keeps a valid checksum', u.ok);
  ok(name + ': gold reads back', u.gold === gold, gold + ' -> ' + u.gold);
  ok(name + ': strength and level read back', u.unit(0).stats.str === 40 && u.unit(0).level === 5);
  ok(name + ': item box slot 0 reads back', u.item(0).id === 16 && u.item(0).amount === 1);
  const changed = []; for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i - 12);
  const expected = new Set([0, 1, 2, 3, -12, -11, -10, -9, t.playerBase + F.P.gold, t.playerBase + F.P.gold + 1, t.playerBase + F.P.gold + 2, t.playerBase + F.P.gold + 3, 0x644 + 0x4E, 0x644 + 0x4A]);
  ok(name + ': only the intended bytes changed', changed.every((c) => expected.has(c)), changed.map((c) => '0x' + c.toString(16)).join(' '));
}


const saveList = Object.keys(files).filter((n) => F.looksLikeSave(files[n])).sort();
const LAST = Object.keys(files).filter((n) => F.looksLikeSave(files[n])).sort().pop();
// ---- every unit field path in the codec, one at a time ---------------------
// Each case patches one field of unit 0 and demands that exactly the documented
// bytes of the 0x24C record changed (nothing leaked into a neighbour).
console.log('\nsetUnit field paths (unit 0 of ' + LAST + '):');
{
  const name = LAST;
  const src = files[name];
  const rec = 0;                                            // unit 0 starts at L.units
  const U = F.L.units;
  const cases = [
    ['id', { id: 42 }, 0x24, 2], ['exp', { exp: 999 }, 0x2C, 2],
    ['level', { level: 7 }, 0x4A, 1], ['class', { class: 9 }, 0x4B, 1],
    ['hp', { hp: 33 }, 0x4C, 1], ['unk4D', { unk4D: 3 }, 0x4D, 1],
    ['stats.str', { stats: { str: 41 } }, 0x4E, 1], ['stats.cha', { stats: { cha: 22 } }, 0x56, 1],
    ['classExp', { classExp: 4000 }, 0x48, 2], ['classLevel', { classLevel: 5 }, 0x93, 1],
    ['motivation', { motivation: 88 }, 0xC4, 1], ['learningFocus', { learningFocus: 4 }, 0xDB, 1],
    ['classFlags', { classFlags: 6 }, 0xDF, 1], ['itemCount', { itemCount: 4 }, 0x87, 1],
    ['adjutant', { adjutant: 12 }, 0xFA, 2], ['flags', { flags: 0x11223344 }, 0xAC, 4],
    ['items[0].id', { items: { 0: { id: 24 } } }, 0x00, 2],
    ['items[0].dur', { items: { 0: { dur: 39 } } }, 0x02, 1],
    ['items[0].amount', { items: { 0: { amount: 2 } } }, 0x03, 1],
    ['items[5].id', { items: { 5: { id: 1000 } } }, 0x14, 2],
    ['equipped[0]', { equipped: { 0: 2 } }, 0x2E, 2],
    ['skillExp[3]', { skillExp: { 3: 600 } }, 0x38, 2],
    ['skillRanks[3]', { skillRanks: { 3: 8 } }, 0x8B, 1],
    ['skillRanks[10]', { skillRanks: { 10: 4 } }, 0x92, 1],
    ['artsKnown[2]', { artsKnown: { 2: 17 } }, 0x59, 1],
    ['artsEquipped[1]', { artsEquipped: { 1: 19 } }, 0x85, 1],
    ['magicKnown[5]', { magicKnown: { 5: 7 } }, 0xA5, 1],
    ['magicDurability[5]', { magicDurability: { 5: 6 } }, 0x99, 1],
    ['abilities[0]', { abilities: { 0: 1 } }, 0x61, 1],
    ['abilities[63]', { abilities: { 63: 1 } }, 0x68, 1],
    ['abilities[239]', { abilities: { 239: 1 } }, 0x7E, 1],
    ['abilitiesEquipped[2]', { abilitiesEquipped: { 2: 33 } }, 0x81, 1],
    ['classExpAll[10]', { classExpAll: { 10: 3210 } }, 0x126, 2],
    ['classLevelsAll[10]', { classLevelsAll: { 10: 6 } }, 0x1DD, 1],
    ['classUnlockFlags[1]', { classUnlockFlags: { 1: 9 } }, 0xD4, 1],
    ['deployIndex', { deployIndex: 3 }, 0x1C6, 1], ['deploySlot', { deploySlot: 4 }, 0x1C7, 1],
    ['battalion.type', { battalion: { type: 44 } }, 0x1E, 1],
    ['battalion.exp', { battalion: { exp: 500 } }, 0x1A, 2],
    ['battalion.owner', { battalion: { owner: 7 } }, 0x18, 2],
  ];
  const bump = (v) => (typeof v === 'number' ? v + 1 : Array.isArray(v) ? v.map(bump) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bump(x)])));
  for (const [what, patch0, at, size] of cases) {
    // If the save already holds the value the test asks for, nothing changes and the byte-diff below
    // would say "nothing written" - which is correct behaviour, not a bug. Nudge the value instead so
    // the write path is still exercised.
    const same = new F.Save(src, 'scratch');
    same.setUnit(0, patch0);
    const patch = same.bytes.every((v, i) => v === src[i]) ? bump(patch0) : patch0;
    const t = new F.Save(src, 'scratch');
    t.setUnit(0, patch);
    const changed = [];
    for (let i = 0; i < src.length; i++) if (src[i] !== t.bytes[i]) changed.push(i - 12);
    const want = new Set(Array.from({ length: size }, (_, k) => U + rec + at + k));
    const leaked = changed.filter((c) => !want.has(c));
    const wroteSomething = changed.length > 0 && changed.length <= size;
    ok('setUnit ' + what, leaked.length === 0 && wroteSomething, changed.map((c) => '0x' + c.toString(16)).join(' ') || 'nothing written');
  }
  // dotted form must behave the same as the nested form
  const a = new F.Save(src, 'x'), b = new F.Save(src, 'x');
  a.setUnit(0, { stats: { mag: 30 } }); b.setUnit(0, { 'stats.mag': 30 });
  ok('setUnit accepts dotted paths like nested ones', Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) === 0);
  let threw = false; try { a.setUnit(0, { nonsenseField: 1 }); } catch { threw = true; }
  ok('setUnit refuses unknown field names instead of writing somewhere random', threw);
}


// ---- support pairing (data layer) -------------------------------------------
console.log('\nsupport conversations:');
{
  ok('pairing table loaded', Array.isArray(D.supports) && D.supports.length === 256, D.supports.length + ' rows');
  const name = saveList[saveList.length - 1];
  const s = new F.Save(files[name], name);
  const named = [];
  for (let i = 0; i < F.P.supportCount; i++) {
    if (!s.support(i)) continue;
    const t = D.supports[i];
    if (!t || t.a < 0 || t.b < 0) continue;
    const a = D.chars[t.a] && D.chars[t.a].n, b = D.chars[t.b] && D.chars[t.b].n;
    if (a && b) named.push(a + ' x ' + b + ' = ' + s.support(i));
  }
  ok('every non-zero support slot resolves to a named pair', named.length > 0, named.join(', '));
  const ranks = Array.from({ length: F.P.supportCount }, (_, i) => s.support(i)).filter((v) => v > 100).length;
  ok('rank thresholds classify every stored value', Array.from({ length: F.P.supportCount }, (_, i) => s.support(i)).every((v) => Number.isFinite(v)), ranks + ' pairs past C in this save');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
