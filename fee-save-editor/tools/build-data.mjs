/* Regenerates js/data-<lang>.js from tools/sources/.
   The save stores every reference as an FNV-1a hash of a Japanese ID string ("IID_ほそみの剣"), so the
   page needs the ID list, the English name for each ID, and the limits that go with it (max uses, max
   level, stat caps, bond thresholds). Those come from the game's own tables, dumped here as JSON.

     node tools/build-data.mjs            # writes js/data-en.js
     LANGS=ja node tools/build-data.mjs   # if you ever drop a Japanese name column in

   The output merges into window.FEE_DATA[<lang>], so index.html just loads one script per language. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'sources');
const LANGS = (process.env.LANGS || 'en').split(',').map((s) => s.trim()).filter(Boolean);

/* Same hash the game uses: FNV-1a/32 over UTF-16 code units, offset 2166136261, prime 16777619.
   Must match fnv1a() in js/fee.js exactly - the page looks names up by this number. */
function fnv1a(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h, 16777619) >>> 0; h = (h ^ s.charCodeAt(i)) >>> 0; }
  return h >>> 0;
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const pick = (names, lang) => (names && (names[lang] || names.en)) || '';

const ITEMS = { 1: 'Sword', 2: 'Lance', 3: 'Axe', 4: 'Bow', 5: 'Dagger', 6: 'Magic', 7: 'Staff', 8: 'Combat Art', 9: 'Breath', 10: 'Item' };

const items = read('items.json'), roster = read('roster.json'), emblems = read('emblems.json'),
  supports = read('supports.json'), quantity = read('quantity-items.json'), engravings = read('engravings.json'),
  melding = read('bond-ring-melding.json'), bracelets = read('bracelets.json');

const byLang = {};
for (const lang of LANGS) byLang[lang] = { lang };

for (const lang of LANGS) {
  const d = byLang[lang];
  d.itemKinds = ITEMS;
  d.items = items.Items.map((x) => ({ h: fnv1a(x.Id), i: x.Id, n: pick(x.Names, lang) || x.English, k: x.Kind, u: x.MaxUses, r: x.MaxRefine }));
  // names for references that are not convoy items: accessories, mount/robe ids, emblems' own items, ...
  d.itemNames = roster.ItemNames.map((x) => ({ h: fnv1a(x.Id), i: x.Id, n: pick(x.Names, lang), e: x.EngageOnly }));
  d.persons = roster.Persons.map((p) => ({ h: fnv1a(p.Id), i: p.Id, n: pick(p.Names, lang), g: p.Gender, birth: p.BirthClass, lm: p.LimitModifiers }));
  d.classes = roster.Classes.map((c) => ({
    h: fnv1a(c.Id), i: c.Id, n: pick(c.Names, lang), max: c.MaxLevel, fl: c.Flags, adv: c.Advanced,
    promo: c.Promotion, learn: c.LearningSkill, w: c.Weapons, base: c.BaseStats, lim: c.Limits,
  }));
  d.skills = roster.Skills.map((s) => ({
    h: fnv1a(s.Id), i: s.Id, n: pick(s.Names, lang), inh: s.Inheritable, f: fnv1a(s.Family), fn: s.Family, t: s.Tier,
  }));
  d.emblems = emblems.Emblems.map((e) => ({ h: fnv1a(e.Id), i: e.Id, n: pick(e.Names, lang), cap: e.LevelCapVariable || null, dlc: !!e.Dlc }));
  d.rings = emblems.Rings.map((r) => ({
    h: fnv1a(r.Id), i: r.Id, n: pick(r.Names, lang), em: r.EmblemId, rk: r.Rank, single: r.SingleRank,
    st: r.StatBonuses, sk: (r.Skills || []).map((s) => ({ i: s.Id, n: pick(s.Names, lang), d: pick(s.Descriptions, lang) })),
  }));
  d.bondExp = emblems.BondExperience;
  d.supports = supports.Pairs.map((p) => ({ a: p.FirstPersonId, b: p.SecondPersonId, ah: fnv1a(p.FirstPersonId), bh: fnv1a(p.SecondPersonId), t: p.Thresholds }));
  d.quantity = quantity.Items.map((x) => ({ h: fnv1a(x.Id), i: x.Id, n: pick(x.Names, lang), c: x.Category, max: x.Maximum }));
  // an engraving is an Emblem's name carved into a weapon, so its label is that Emblem's name
  const emblemName = {};
  for (const e of emblems.Emblems) emblemName[e.Id] = pick(e.Names, lang) || e.Id;
  d.engravings = engravings.Engravings.map((x) => ({
    h: fnv1a(x.Id), i: x.Id, n: emblemName[x.Id] || x.Id,
    ah: [x.Id].concat(x.Aliases || []).map(fnv1a), ai: [x.Id].concat(x.Aliases || []),
    p: x.Power, w: x.Weight, hit: x.Hit, c: x.Critical, av: x.Avoid, s: x.Secure,
  }));
  // only these weapons can carry an engraving at all
  d.engraveWeapons = (engravings.Weapons || []).map(fnv1a);
  // the seven DLC Bracelets: one Emblem, several heroes, bonds filed under one of them
  d.bracelets = bracelets.Bracelets.map((x) => ({
    i: x.HolderId, h: fnv1a(x.HolderId), n: x.Name, who: x.Heroes, wave: x.Wave, gh: x.MemberIds.map(fnv1a),
  }));
  d.meldRules = melding.Rules.map((r) => ({ rank: r.SourceRank, need: r.RequiredRings, fragments: r.BondFragments }));

  // sanity: every ID the page will look up must hash uniquely, or names would come back wrong
  const clash = (list, get) => {
    const seen = new Map();
    for (const x of list) { const k = get(x); if (seen.has(k)) throw new Error(lang + ': hash clash ' + k + ' (' + seen.get(k) + ' vs ' + x.i + ')'); seen.set(k, x.i); }
  };
  clash(d.items, (x) => x.h); clash(d.classes, (x) => x.h); clash(d.skills, (x) => x.h); clash(d.rings, (x) => x.h);
}

const dest = path.join(HERE, '..', 'js');
fs.mkdirSync(dest, { recursive: true });
for (const lang of LANGS) {
  const file = path.join(dest, 'data-' + lang + '.js');
  // merges rather than replaces, so index.html can load one <script> per language
  fs.writeFileSync(file, 'window.FEE_DATA = window.FEE_DATA || {};\nwindow.FEE_DATA[' + JSON.stringify(lang) + '] = ' + JSON.stringify(byLang[lang]) + ';\n');
  console.log(path.relative(path.join(HERE, '..'), file) + ': ' + (fs.statSync(file).size / 1024).toFixed(0) + ' KB · '
    + byLang[lang].items.length + ' items, ' + byLang[lang].persons.length + ' people, '
    + byLang[lang].classes.length + ' classes, ' + byLang[lang].skills.length + ' skills, '
    + byLang[lang].rings.length + ' rings, ' + byLang[lang].quantity.length + ' quantity items, '
    + byLang[lang].bracelets.length + ' bracelets');
}
