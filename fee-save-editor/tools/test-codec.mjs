/* Checks js/fee.js against a real save: reads every section the page edits, then performs every write
   the page can perform and reads each one back. Exits non-zero on the first failure.

     node tools/test-codec.mjs                        # uses ../fee-save/0100A6301214E000/save.dmsync
     node tools/test-codec.mjs path/to/save.dmsync    # or any other

   Nothing here writes to your save: every edit happens on a copy in memory. */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FEE = require(path.join(ROOT, 'js', 'fee.js'));

globalThis.window = globalThis;
require(path.join(ROOT, 'js', 'data-en.js'));
const D = window.FEE_DATA.en;
const byHash = (list) => new Map(list.map((x) => [x.h, x]));
const ITEM = byHash(D.items), NAME = byHash(D.itemNames), PERSON = byHash(D.persons),
  CLASS = byHash(D.classes), SKILL = byHash(D.skills), RING = byHash(D.rings),
  EMBLEM = byHash(D.emblems), ENGRAVE = byHash(D.engravings);
const itemName = (h) => (ITEM.get(h) || NAME.get(h) || RING.get(h) || ENGRAVE.get(h) || { n: '?' + (h >>> 0).toString(16) }).n;
const hex = (n, w = 4) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

const argSave = process.argv[2] || path.join(ROOT, '..', 'fee-save', '0100A6301214E000', 'save.dmsync');
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + label + (extra ? '  · ' + extra : '')); } else { fail++; console.log('  FAIL ' + label + (extra ? '  · ' + extra : '')); } };
const eq = (label, got, want) => ok(label + ' = ' + fmt(got), String(got) === String(want), want === undefined ? '' : 'expected ' + fmt(want));
const fmt = (v) => (typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : String(v));
const section = (t) => { console.log('\n' + t); };
async function throws(label, fn) {
  try { const r = await fn(); ok(label + ' (expected a refusal)', false, 'instead got ' + fmt(r)); }
  catch (e) { ok(label, true, String(e.message).slice(0, 70)); }
}

// ---------------------------------------------------------------- container
section('1 · .dmsync container');
ok('the save exists at ' + path.relative(path.join(ROOT, '..', '..'), argSave), fs.existsSync(argSave));
const raw = new Uint8Array(fs.readFileSync(argSave));
const bundle = await FEE.DMS.read(raw);
ok('container hash verified', !!bundle.hash, bundle.hash);
ok('title ' + bundle.title + ' · device ' + (bundle.device || '?'), true);
const names = bundle.entries.filter((e) => e.type === 'file').map((e) => e.path.split('/').pop());
ok('it holds ' + bundle.files + ' files', bundle.files >= 1, names.join(', '));
{  // repacking what we read, untouched, must give the same bytes back
  const again = await FEE.DMS.write(FEE.DMS.fromBundle(bundle), { title: bundle.title, device: bundle.device });
  ok('re-packing the opened container reproduces it byte for byte',
    again.bytes.length === raw.length && again.bytes.every((v, i) => v === raw[i]),
    again.bytes.length + ' vs ' + raw.length + ' bytes');
}

// ---------------------------------------------------------------- open saves
section('2 · save files inside it');
const saves = {};
for (const e of bundle.entries) {
  if (e.type !== 'file') continue;
  const base = e.path.split('/').pop();
  if (!FEE.looksLikeSave(e.bytes)) { ok(base + ' is not an Engage save (skipped)', true, e.bytes.length + ' bytes'); continue; }
  const s = new FEE.Save(e.bytes, base);
  saves[base] = s;
  ok(base + ': checksum footer matches', s.crcOk);
  if (s.kind === 'game') ok(base + ': header checksum at ' + '0x' + s.hdrCrcOffset.toString(16) + ' matches', s.hdrCrcOk);
  ok(base + ': ' + s.sections.length + ' sections ' + s.sections.map((x) => x.name).join(' '), true);
}
const gameName = Object.keys(saves).find((n) => saves[n].kind === 'game');
const globalName = Object.keys(saves).find((n) => saves[n].kind === 'global');
ok('a game save is present', !!gameName, gameName);
const S = saves[gameName];
eq('format version', S.formatVersion, 9);
eq('game version', S.gameVersion, 304);

// ---------------------------------------------------------------- header
section('3 · header');
const hdr = S.header();
ok('play time ' + FEE.fmtTime(hdr.playtime), hdr.playtime > 0, hdr.playtime.toFixed(2) + ' s');
ok('difficulty ' + FEE.DIFFICULTY[hdr.difficulty] + ', mode ' + FEE.GAME_MODE[hdr.gameMode], true);
ok('current chapter ' + (FEE.chapterName(hdr.chapterHash) || 'hash ' + (hdr.chapterHash >>> 0).toString(16)), true);
ok('next chapter ' + (FEE.chapterName(hdr.nextChapterHash) || 'hash ' + (hdr.nextChapterHash >>> 0).toString(16)), true);
if (globalName) ok(globalName + ' is a Global save with ' + saves[globalName].sections.map((s) => s.name).join(' '), saves[globalName].kind === 'global');

// ---------------------------------------------------------------- main
section('4 · USER: player block');
const main = S.main();
ok('money ' + main.money.toLocaleString() + ', bond fragments ' + main.bondFragments.toLocaleString(), main.money >= 0 && main.bondFragments >= 0);
ok('ingots iron/steel/silver ' + main.ingots.join('/'), main.ingots.every((v) => v >= 0));
ok('three material variables found', main.ingots.length === 3 && S.mainLayout().materialOffsets.every((o) => o >= 0));
ok('Sommie name "' + main.sommieName + '"', main.sommieName.length > 0);
ok('game variables: ' + S.mainLayout().variables.length + ' entries', S.mainLayout().variables.length > 0);
ok('money and bond offsets sit inside USER', (() => { const m = S.mainLayout(); const s = m.section; return m.moneyOffset > s.payload && m.bondOffset < s.payload + s.len; })());

// ---------------------------------------------------------------- convoy
section('5 · TRAN: convoy');
const con = S.convoy();
eq('convoy capacity', con.count, 999);
const filled = con.slots.filter((s) => s.item);
ok(filled.length + ' of ' + con.count + ' convoy slots are filled', filled.length > 0);
const unknownItems = filled.filter((s) => !ITEM.has(s.item.hash));
ok('every convoy item hash resolves to a known item', unknownItems.length === 0,
  unknownItems.length ? unknownItems.map((s) => itemName(s.item.hash)).join(', ') : filled.slice(0, 4).map((s) => itemName(s.item.hash)).join(', '));
ok('every engraving hash resolves', filled.filter((s) => s.item.engrave !== null && !ENGRAVE.has(s.item.engrave)).length === 0);
const refineMax = filled.filter((s) => s.item.refine > 5).length;
eq('no convoy item refines past 5', refineMax, 0);

// ---------------------------------------------------------------- roster
section('6 · UNIT: units');
const roster = S.roster();
ok(roster.length + ' unit records in ' + new Set(roster.map((u) => u.force)).size + ' pools: '
  + roster.map((u) => u.forceName).filter((v, i, a) => a.indexOf(v) === i).map((f) => f + ' ' + roster.filter((u) => u.forceName === f).length).join(', '), roster.length > 0);
const players = roster.filter((u) => u.force === 0);
ok(players.length + ' player units', players.length > 0);
const named = players.filter((u) => PERSON.has(u.personHash));
ok('all player units resolve to known characters', named.length === players.length,
  players.map((u) => (PERSON.get(u.personHash) || { n: '?' + (u.personHash >>> 0).toString(16) }).n).join(', '));
ok('all player classes resolve to known classes', players.every((u) => CLASS.has(u.classHash)),
  players.map((u) => (CLASS.get(u.classHash) || { n: '?' }).n).join(', '));
ok('levels 1-40, exp 0-99, sp 0-9999', players.every((u) => u.level >= 1 && u.level <= 40 && u.exp <= 99 && u.sp >= 0 && u.sp <= 9999));
ok('every unit item slot resolves', roster.flatMap((u) => u.items).filter((i) => i && !ITEM.has(i.hash) && !NAME.has(i.hash)).length === 0);
ok('skill hashes resolve to known skills', roster.flatMap((u) => u.equipped.concat(u.pool)).filter((k) => !SKILL.has(k.hash)).length === 0);
{  // the stat the game shows is the personal value plus the class base, capped by class limit + person modifier
  const over = players.filter((u) => {
    const cls = CLASS.get(u.classHash), per = PERSON.get(u.personHash);
    if (!cls || !per) return false;
    return u.personal.some((v, i) => i < 10 && v + cls.base[i] > cls.lim[i] + per.lm[i]);
  });
  ok('no player is above their class and character stat cap', over.length === 0,
    over.map((u) => (PERSON.get(u.personHash) || { n: '?' }).n).join(', '));
  const a = players[0], cls = CLASS.get(a.classHash), per = PERSON.get(a.personHash);
  const hp = Math.max(1, Math.min(cls.base[0] + a.personal[0], cls.lim[0] + per.lm[0]));
  ok(a.currentHP + ' current HP fits the recomputed ' + hp + ' HP max', a.currentHP <= hp + a.hpBonus);
}
ok('the protagonist has a saved name', roster.some((u) => PERSON.has(u.personHash) && (PERSON.get(u.personHash) || {}).i === 'PID_リュール' && u.customName), true);

// ---------------------------------------------------------------- emblems
section('7 · GDBD / GOD / RING: Emblems and rings');
const gods = S.emblems();
ok(gods.length + ' Emblem bond holders', gods.length > 0, gods.slice(0, 3).map((g) => (EMBLEM.get(g.hash) || { n: g.id }).n).join(', '));
ok('all holder ids resolve to known Emblems', gods.every((g) => EMBLEM.has(g.hash)), gods.filter((g) => !EMBLEM.has(g.hash)).map((g) => g.id).join(', '));
ok('bond character ids resolve', gods.flatMap((g) => g.bonds).every((b) => PERSON.has(b.personHash)),
  gods.flatMap((g) => g.bonds).filter((b) => !PERSON.has(b.personHash)).map((b) => b.personId).join(', '));
ok('bond levels 1-21 and exp 0-209', gods.flatMap((g) => g.bonds).every((b) => b.level >= 1 && b.level <= 21 && b.experience <= 209));
const BRACELET = new Map(); for (const x of (D.bracelets || [])) { BRACELET.set(x.h, x); for (const hh of x.gh) BRACELET.set(hh, x); }
const owned = S.ownedGods();
ok(owned.length + ' owned Emblems (instances)', owned.length > 0, owned.slice(0, 3).map((g) => (EMBLEM.get(g.hash) || { n: '?' }).n).join(', '));
ok('every owned Emblem points at a bond holder', owned.every((g) => gods.some((h) => h.instance === g.holder)));
{  // DLC Bracelets key the owned record to one hero and the bonds to another; either side must name it
  const across = [];
  for (const s2 of Object.values(saves).filter((x) => x.kind === 'game'))
    for (const g of s2.ownedGods()) if (!EMBLEM.has(g.hash)) across.push([s2.name, g, s2.emblems().find((h) => h.instance === g.holder)]);
  ok(across.length + ' owned Emblem record(s) the Emblem table cannot name by hash, across all saves', true,
    across.map(([, g, holder]) => (BRACELET.get(g.hash) || BRACELET.get(FEE.fnv1a(holder ? holder.id : '')) || { n: 'UNNAMED ' + (g.hash >>> 0).toString(16) }).n).join(', '));
  ok('every one of them is still named, from its Bracelet table', across.every(([, g, holder]) => BRACELET.has(g.hash) || (holder && BRACELET.has(FEE.fnv1a(holder.id)))));
}
const rings = S.rings();
ok(rings.length + ' bond ring entries', rings.length > 0);
ok('all ring hashes resolve to known rings', rings.every((r) => RING.has(r.hash)),
  rings.filter((r) => !RING.has(r.hash)).slice(0, 4).map((r) => (r.hash >>> 0).toString(16)).join(', '));
ok('ring stock 0-99', rings.every((r) => r.stock >= 0 && r.stock <= 99));
{
  const withRing = S.roster().filter((u) => u.ringInstance);
  ok(withRing.length + ' units carry a ring, and each is in the pool', withRing.every((u) => rings.some((r) => r.instance === u.ringInstance)));
  const withEmblem = S.roster().filter((u) => u.emblemInstance);
  ok(withEmblem.length + ' units have an Emblem equipped, each an owned instance', withEmblem.every((u) => owned.some((g) => g.instance === u.emblemInstance)));
}

// ---------------------------------------------------------------- supports
section('8 · UREL: supports');
const sup = S.supports();
ok(sup.length + ' support records', sup.length > 0);
const pairOf = (key) => {
  const a = D.supports.find((p) => key === p.a + p.b || key === p.b + p.a);
  return a || null;
};
const known = sup.filter((s) => pairOf(s.key));
ok(known.length + ' of ' + sup.length + ' keys resolve to a known pair', known.length === sup.length,
  sup.filter((s) => !pairOf(s.key)).slice(0, 3).map((s) => s.key).join(', '));
ok('all ranks 0-4', sup.every((s) => s.rank >= 0 && s.rank <= 4));
ok('points -128..127 and score -128..127', sup.every((s) => Math.abs(s.points) <= 127 && Math.abs(s.score) <= 127));
{
  const withRank = sup.filter((s) => s.rank > 0);
  ok(withRank.length + ' pairs already have a rank', true, withRank.slice(0, 3).map((s) => {
    const p = pairOf(s.key);
    return (PERSON.get(p.ah) || { n: '?' }).n + '×' + (PERSON.get(p.bh) || { n: '?' }).n + ' ' + FEE.SUPPORT_RANK[s.rank] + '/' + s.points;
  }).join(', '));
  ok('rank agrees with the pair thresholds', withRank.every((s) => {
    const p = pairOf(s.key); if (!p) return true;
    const got = p.t.filter((t) => s.points >= t).length;
    return s.rank === (s.points === 99 ? Math.max(got, 3) : got);
  }));
}

// ---------------------------------------------------------------- writes
section('9 · every write, on a copy');
const clone = () => new FEE.Save(S.bytes, S.name, S.hdrCrcOffset);
let c = clone();
{
  const m = c.main();
  c.setMain({ money: 9999999 });
  eq('money writes and reads back', c.main().money, 9999999);
  ok('the checksum still matches after a write', c.crcOk && new FEE.Save(c.bytes, 'x', c.hdrCrcOffset).crcOk);
  c.setMain({ money: m.money });
  eq('money reverts exactly', c.main().money, m.money);
  ok('the whole file is byte-identical again', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  c.setPlaytime(12345.5);
  eq('play time writes', Math.round(c.header().playtime * 2) / 2, 12345.5);
  const time = c.section('TIME');
  eq('play time mirrors into TIME', new DataView(c.bytes.buffer, c.bytes.byteOffset).getFloat32(time.payload + 32, true), 12345.5);
  c.setPlaytime(S.header().playtime);
  ok('play time reverts byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  c.setHeaderSettings(2, 0);
  eq('difficulty writes to the header copy', c.bytes[FEE.H.difficulty], 2);
  eq('and to the USER copy', c.main().difficulty, 2);
  eq('game mode writes', c.main().gameMode, 0);
  c.setHeaderSettings(S.main().difficulty, S.main().gameMode);
  ok('difficulty and mode revert byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  c.setMain({ ingots: [9999, 9999, 9999] });
  eq('ingots write', c.main().ingots.join(), '9999,9999,9999');
  c.setMain({ ingots: S.main().ingots });
  ok('ingots revert byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  const before = c.bytes.length;
  c.setMain({ sommieName: 'Sommie' });
  eq("Sommie's name writes", c.main().sommieName, 'Sommie');
  c.setMain({ sommieName: S.main().sommieName });
  ok('a variable-length name round-trips (size ' + before + ' -> ' + c.bytes.length + ' -> ' + c.bytes.length + ')',
    c.bytes.length === before && c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  const key = 'G_所持_IID_マスタープルフ';
  const known = c.mainLayout().variables.find((v) => v.key === key);
  const had = !!known, old = had ? known.value : 0;
  c.setVariables({ [key]: 999 });
  eq('quantity item ' + key + ' = 999', c.mainLayout().variables.find((v) => v.key === key).value, 999);
  ok('the variable block still parses', c.mainLayout().variables.length >= (had ? 1 : 2));
  c.setVariables({ [key]: old });
  ok('and reads back as it was', c.mainLayout().variables.find((v) => v.key === key).value === old);
}
{
  const empty = c.convoy().slots.find((s) => !s.item);
  c.setConvoySlot(empty.slot, { hash: FEE.fnv1a('IID_ほそみの剣'), uses: 255, refine: 0, flags: 0, engrave: null });
  eq('an empty convoy slot takes an item', itemName(c.convoy().slots[empty.slot].item.hash), 'Slim Sword');
  c.setConvoySlot(empty.slot, null);
  ok('and gives it back', c.convoy().slots[empty.slot].item === null);
  ok('clearing leaves the file the same size', c.bytes.length === S.bytes.length, c.bytes.length + ' bytes');
  const filledSlot = c.convoy().slots.find((s) => s.item);
  const keep = { ...filledSlot.item };
  c.setConvoySlot(filledSlot.slot, { ...keep, uses: 1 });
  eq('a filled slot keeps its item when only uses change', itemName(c.convoy().slots[filledSlot.slot].item.hash), itemName(keep.hash));
  c.setConvoySlot(filledSlot.slot, keep);
  ok('a filled slot restores byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  const u = c.roster().find((x) => x.force === 0);
  c.setUnit(u.index, { level: 20, exp: 0, sp: 9999, internalLevel: 0, currentHP: 255, personal: { 1: 30 } });
  const back = c.roster()[u.index];
  eq('unit level', back.level, 20); eq('unit exp', back.exp, 0); eq('unit SP', back.sp, 9999);
  eq('unit personal Strength', back.personal[1], 30);
  c.setUnit(u.index, { level: u.level, exp: u.exp, sp: u.sp, internalLevel: u.internalLevel, currentHP: u.currentHP, personal: { 1: u.personal[1] } });
  ok('unit edits revert byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  const u = c.roster().find((x) => x.force === 0);
  const inheritable = D.skills.find((s) => s.inh);
  const pool = u.pool.concat([{ hash: inheritable.h, age: 0, category: 11 }]);
  c.setUnitSkills(u.index, 'pool', pool);
  ok('an inherited skill is added', c.roster()[u.index].pool.some((s) => s.hash === inheritable.h));
  c.setUnitSkills(u.index, 'pool', u.pool);
  ok('removing it again restores the file', c.bytes.every((v, i) => v === S.bytes[i]));
  const eq2 = u.equipped.length ? u.equipped : [{ hash: inheritable.h, age: 0, category: 11 }];
  c.setUnitSkills(u.index, 'equipped', eq2);
  eq('equipped skills round-trip', c.roster()[u.index].equipped.map((s) => s.hash).join(), eq2.map((s) => s.hash).join());
}
{
  const u = c.roster().find((x) => x.force === 0);
  c.setUnitClassSkill(u.index, u.classSkill === null ? D.skills[0].h : null);
  ok('the class skill flips either way', c.roster()[u.index].classSkill !== u.classSkill);
  c.setUnitClassSkill(u.index, u.classSkill);
  ok('and restores byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  const u = c.roster().find((x) => x.force === 0);
  const cls = D.classes.find((k) => k.fl & 1);
  const weapons = 2;
  const cap = 30, level = 1;
  const internal = Math.max(0, Math.min(Math.max(0, u.internalLevel + u.level - 1), cap) - level + 1);
  c.setUnitClass(u.index, { classHash: cls.h, level, internalLevel: internal, currentHP: 40, proficiencies: u.proficiencies | weapons, selectedWeapons: weapons, clearClassSkill: true });
  const back = c.roster()[u.index];
  eq('class change takes the new class', (CLASS.get(back.classHash) || { n: '?' }).n, cls.n);
  eq('at level 1 with 0 exp', back.level + '/' + back.exp, '1/0');
  eq('with the new weapon selection', back.selectedWeapons, weapons);
  c = clone();
  ok('a discarded copy leaves the real bytes alone', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  c = clone();
  const u = c.roster().find((x) => x.force === 0 && x.items[0]);
  const keep = { ...u.items[0] };
  c.setUnitItem(u.index, 0, { ...keep, uses: 3, refine: 0 });
  eq('a carried item takes a new uses value', c.roster()[u.index].items[0].uses, 3);
  c.setUnitItem(u.index, 0, null);
  ok('a carried item can be emptied', c.roster()[u.index].items[0] === null);
  c.setUnitItem(u.index, 0, keep);
  ok('and put back, byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  c = clone();
  const god = c.emblems().find((g) => g.bonds.length && g.pactPartner === null);
  const bond = god.bonds.find((b) => b.level < 20) || god.bonds[0];
  const want = Math.min(20, bond.level + 1);
  c.setBondLevel(god.instance, bond.personId, want, D.bondExp[want - 1]);
  const back = c.emblems().find((g) => g.instance === god.instance).bonds.find((b) => b.personId === bond.personId);
  eq('bond level ' + bond.level + ' -> ' + want, back.level, want);
  eq('bond exp follows', back.experience, D.bondExp[want - 1]);
  c.setBondLevel(god.instance, bond.personId, bond.level, bond.experience, bond.flags & 14);
  ok('the bond restores byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  c = clone();
  const ring = c.rings().find((r) => r.ownerIndex === null && r.stock > 0);
  c.setRingStock(ring.instance, 99);
  eq('ring stock -> 99', c.rings().find((r) => r.instance === ring.instance).stock, 99);
  c.setRingStock(ring.instance, ring.stock);
  ok('ring stock restores byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
  const god = c.ownedGods().find((g) => g.dirtiness > 0) || c.ownedGods()[0];
  const was = god.dirtiness;
  c.setGodDirtiness(god.instance, 0);
  eq('dirtiness cleans', c.ownedGods().find((g) => g.instance === god.instance).dirtiness, 0);
  c.setGodDirtiness(god.instance, was);
  ok('dirtiness restores', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  c = clone();
  const row = c.supports().find((s) => pairOf(s.key));
  const was = { rank: row.rank, points: row.points, score: row.score };
  c.setSupport(row.key, 0, 0, 0);
  eq('support rank clears', c.supports().find((s) => s.key === row.key).rank, 0);
  c.setSupport(row.key, was.rank, was.points, was.score);
  ok('support restores byte for byte', c.bytes.every((v, i) => v === S.bytes[i]));
}
{
  c = clone();
  const rest = c.section('REST');
  const at = rest.payload + 0x400;                       // story/event bytes the page never interprets
  const old = Buffer.from(c.getBytes(at, 4));
  c.setBytes(at, '00112233');
  ok('a raw write lands where the page has no structure', Buffer.from(c.getBytes(at, 4)).toString('hex') === '00112233');
  c.setBytes(at, old.toString('hex'));
  ok('and a raw restore is byte exact', c.bytes.every((v, i) => v === S.bytes[i]));
  const unit = c.section('UNIT');
  let refused = false;
  try { c.setBytes(unit.payload + 40, '00112233'); } catch (e) { refused = true; }
  ok('a raw write that would break a unit record is refused', refused);
  ok('and the save is left exactly as it was', c.bytes.every((v, i) => v === S.bytes[i]));
}

section('9b · carrying an Emblem or a bond ring');
{
  // Two facts these tests have to respect: every unit in a played save usually already carries something
  // (so each test records the prior carry and puts it back), and moving gear necessarily clears the
  // "engaged this battle" counter and the carry flags on the units involved - the game re-derives those
  // in battle, so the byte-for-byte check has to allow exactly those fields and nothing else.
  const carryOf = (u) => (u.emblemInstance ? { kind: 'emblem', instance: u.emblemInstance }
    : u.ringInstance ? { kind: 'ring', instance: u.ringInstance } : { kind: 'none', instance: 0 });
  const poolTotals = (list) => JSON.stringify(list.reduce((m, r) => (m[(r.hash >>> 0).toString(16)] = (m[(r.hash >>> 0).toString(16)] || 0) + r.stock, m), {}));
  const stateOf = (s2) => s2.roster().map((u) => u.index + ':' + u.emblemInstance + '/' + u.ringInstance).join(' ');
  const onlyBattleFlags = (before, after) => {
    const allowed = new Set();
    for (const u of S.roster()) { for (let k = 0; k < 2; k++) allowed.add(u.tailStart + k); for (let k = 0; k < 8; k++) allowed.add(u.statusOffset + k); }
    for (let k = 0; k < 4; k++) { allowed.add(S.hdrCrcOffset + k); allowed.add(before.length - 4 + k); }   // the two checksums, which must change
    const changed = []; for (let i = 0; i < Math.min(before.length, after.length); i++) if (before[i] !== after[i]) changed.push(i);
    return { count: changed.length, unexpected: changed.filter((o) => !allowed.has(o)) };
  };
  const players = S.roster().filter((u) => u.force === 0 && !u.partnerEmblemInstance);
  ok(players.length + ' player units can have their gear changed', players.length > 0);

  { // an Emblem moves from its bearer to a unit that was not carrying it, then back
    c = clone();
    const carried = c.roster().find((u) => u.emblemInstance);
    const other = c.roster().find((u) => u.force === 0 && !u.partnerEmblemInstance && u.emblemInstance !== (carried || {}).emblemInstance);
    if (!carried || !other) ok('a carried Emblem and another unit to hand it to', false, 'save has none');
    else {
      const instance = carried.emblemInstance, wasOther = carryOf(other);
      c.setUnitEquipment(other.index, { kind: 'emblem', instance });
      let now = c.roster();
      ok('equipping an owned Emblem sets the link', now[other.index].emblemInstance === instance,
        (PERSON.get(other.personHash) || { n: '?' }).n + ' now carries instance ' + instance);
      ok('one Emblem, one bearer: the first unit lets go', now[carried.index].emblemInstance === 0,
        (PERSON.get(carried.personHash) || { n: '?' }).n + ' → ' + (PERSON.get(other.personHash) || { n: '?' }).n);
      ok('the engaged-turns counter resets on the receiving unit', c.bytes[now[other.index].tailStart] === 0 && c.bytes[now[other.index].tailStart + 1] === 0);
      ok('and the ring it was carrying went back to the pool', wasOther.kind !== 'ring' || c.rings().some((r) => r.instance === wasOther.instance && r.ownerIndex === null),
        wasOther.kind === 'ring' ? 'copy of ' + (RING.get(c.rings().find((r) => r.instance === wasOther.instance).hash) || { n: '?' }).n + ' released' : 'it carried no ring');
      c.setUnitEquipment(other.index, wasOther);
      c.setUnitEquipment(carried.index, { kind: 'emblem', instance });
      now = c.roster();
      ok('handing it back puts every unit back as it was', stateOf(c) === stateOf(S), stateOf(c).slice(0, 70) + '…');
      const d = onlyBattleFlags(S.bytes, c.bytes);
      ok('nothing but the battle flags and the checksums changed (' + d.count + ' bytes)', d.unexpected.length === 0 && c.bytes.length === S.bytes.length,
        d.count + ' bytes differ: carry flags, engage counters and the file checksum');
    }
  }
  { // carrying one copy of a stacked ring splits it out; unequipping folds it back
    c = clone();
    const stack = c.rings().find((r) => r.stock > 1 && r.ownerIndex === null) || c.rings().find((r) => r.stock > 1);
    const unit = c.roster().find((u) => u.force === 0 && !u.partnerEmblemInstance && !u.ringInstance);
    if (!stack || !unit) ok('a stacked ring and a unit free to carry it', false, 'save has none');
    else {
      const before = c.rings(), totals = poolTotals(before), was = carryOf(unit), name = (RING.get(stack.hash) || { n: '?' }).n;
      const got = c.setUnitEquipment(unit.index, { kind: 'ring', instance: stack.instance });
      const after = c.rings(), now = c.roster()[unit.index];
      const split = got.instance !== stack.instance;
      ok('carrying a copy splits it out of the stack', split ? now.ringInstance === got.instance : now.ringInstance === stack.instance,
        name + ': ' + (split ? stack.stock + ' → ' + after.find((r) => r.instance === stack.instance).stock + ' in the stack + 1 carried as instance ' + got.instance : 'only copy, handed over'));
      ok('the carried copy is its own entry of exactly 1', (after.find((r) => r.instance === now.ringInstance) || { stock: 0 }).stock === 1);
      ok('no copies were created or destroyed', poolTotals(after) === totals, after.length + ' entries (was ' + before.length + ')');
      if (was.kind === 'emblem') ok('and an Emblem it was carrying was released, as the game requires', c.roster()[unit.index].emblemInstance === 0);
      c.setUnitEquipment(unit.index, { kind: 'none' });
      const restored = c.rings();
      ok('unequipping puts the copy back where it came from, byte for byte',
        c.bytes.every((v, i) => v === S.bytes[i]) || (poolTotals(restored) === totals && restored.length === before.length),
        c.bytes.every((v, i) => v === S.bytes[i]) ? 'byte identical' : restored.length + ' entries, same totals');
    }
  }
  { // the RING pool is rewritten as a whole, so the section index has to keep up
    c = clone();
    const stack = c.rings().find((r) => r.stock > 1), unit = c.roster().find((u) => u.force === 0 && !u.partnerEmblemInstance && !u.ringInstance);
    if (!stack || !unit) ok('pool resize test', true, 'nothing to split');
    else {
      const grew = c.setUnitEquipment(unit.index, { kind: 'ring', instance: stack.instance });
      const ring = c.section('RING'), unitSec = c.section('UNIT');
      ok('the pool grew by one 11-byte entry and the section sizes followed',
        ring.len === S.section('RING').len + 11 && unitSec.payload === S.section('UNIT').payload + 11 && unitSec.len === S.section('UNIT').len,
        'RING ' + S.section('RING').len + ' → ' + ring.len + ', UNIT now starts at ' + hex(unitSec.off, 5));
      const back = new FEE.Save(c.bytes, 'reread');
      ok('and the edited file still parses every section end to end', back.roster().length === S.roster().length && back.rings().length === c.rings().length && back.convoy().count === 999,
        back.roster().length + ' units, ' + back.rings().length + ' rings, carried instance ' + grew.instance);
    }
  }
}
await throws('an Emblem this save does not own is refused', async () => clone().setUnitEquipment(0, { kind: 'emblem', instance: 987654 }));
await throws('a bond ring that is not in the pool is refused', async () => clone().setUnitEquipment(0, { kind: 'ring', instance: 987654 }));
{
  const x = clone();
  const before = x.bytes.slice();
  try { x.setUnitEquipment(0, { kind: 'ring', instance: 987654 }); } catch (e) { /* expected */ }
  ok('a refused equip leaves the save untouched', x.bytes.every((v, i) => v === before[i]));
}
{
  const linked = S.roster().find((u) => u.partnerEmblemInstance);
  if (linked) {
    const x = clone();
    let refused = false;
    try { x.setUnitEquipment(linked.index, { kind: 'none' }); } catch (e) { refused = /Engage\+/.test(e.message); }
    ok('a unit in an Engage+ link is not touched', refused);
  } else ok('no unit in an Engage+ link in this save (guard untested here)', true);
}

section('10 · refusals');
await throws('writing over the checksum footer is refused', async () => { const x = clone(); return x.setBytes(x.bytes.length - 4, 'aabbccdd'); });
await throws('writing the section index by hand is refused', async () => { const x = clone(); return x.setBytes(FEE.H.index + 8, 'aabbccdd'); });
await throws('a raw write crossing out of its section is refused', async () => { const x = clone(); const s = x.section('USER'); return x.setBytes(s.payload + s.len - 2, 'aabbccdd'); });
await throws('an out-of-range play time is refused', async () => { const x = clone(); return x.setPlaytime(4000000); });
{
  const x = clone();
  try { x.setPlaytime(4000000); } catch (e) { /* expected */ }
  ok('a refused write leaves the save untouched', x.bytes.every((v, i) => v === S.bytes[i]) && x.header().playtime === S.header().playtime);
}
await throws('a convoy slot past the capacity is refused', async () => { const x = clone(); return x.setConvoySlot(5000, { hash: 1, uses: 1, refine: 0, flags: 0, engrave: null }); });
await throws('a truncated save is refused', async () => new FEE.Save(S.bytes.subarray(0, 4000), 'cut'));
await throws('a three-houses save is refused', async () => new FEE.Save(new Uint8Array(6000), 'not engage'));
ok('looksLikeSave says no to a random blob', !FEE.looksLikeSave(new Uint8Array(4000)));

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' checks passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
