/* FE3H save codec: nxnative .dmsync container + Three Houses save file structure.
   Loads in a browser (window.FE3H) and in node (module.exports) so the same code is testable. */
(function (root) {
  'use strict';

  // ============================ nxnative packed save (.dmsync) ============================
  // Byte-exact with dm/host/save_sync.c: DMSYNC1 header, 24-byte entries, SHA-256 over each
  // entry's first 16 header bytes + path + guest name + contents in walk order, DMSYNCE tail.
  const DMS = (function () {
    const MAGIC = [0x44, 0x4d, 0x53, 0x59, 0x4e, 0x43, 0x31, 0x0a], END = [0x44, 0x4d, 0x53, 0x59, 0x4e, 0x43, 0x45, 0x0a];
    const HDR = 8 + 4 + 4 + 32 + 8 + 24 + 64, ENT = 24, HASHCH = 32, FOLDERS = ['save', 'save_device'];
    const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: false });
    const u8 = (n) => new Uint8Array(n);
    const le = (b, o, n) => { let v = 0n; for (let i = 0; i < n; i++) v |= BigInt(b[o + i]) << BigInt(8 * i); return v; };
    const putLe = (b, o, val, n) => { let v = BigInt(val); for (let i = 0; i < n; i++) { b[o + i] = Number(v & 0xffn); v >>= 8n; } };

    async function sha16hex(parts) {
      const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
      return [...d.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    function pathOk(p) {
      if (!(p.startsWith('save/') || p.startsWith('save_device/'))) return false;
      for (let s = p; ;) {
        const e = s.indexOf('/'), part = e < 0 ? s : s.slice(0, e);
        if (!part.length || part === '.' || part === '..') return false;
        if (e < 0) return true; s = s.slice(e + 1);
      }
    }
    async function read(bytes) {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const fail = (why) => { throw new Error(why); };
      if (b.length < HDR + END.length) fail('too short to be a packed save');
      for (let i = 0; i < 8; i++) if (b[i] !== MAGIC[i]) fail('not a packed save: header is not DMSYNC1');
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const version = view.getUint32(8, true), n = view.getUint32(12, true);
      if (version !== 1) fail('container version ' + version + ' (this page writes version 1)');
      const want = dec.decode(b.subarray(16, 16 + HASHCH));
      const saved = Number(le(b, 48, 8)), title = dec.decode(b.subarray(56, 80)).split('\0')[0], device = dec.decode(b.subarray(80, 144)).split('\0')[0];
      if ([...b.slice(b.length - END.length)].join() !== END.join()) fail('cut off: no DMSYNCE end marker');
      const run = [], entries = []; let off = HDR, files = 0;
      const push = (a) => { if (a && a.length) run.push(a); };
      const head = u8(ENT);
      for (let i = 0; i < n; i++) {
        if (off + ENT > b.length - END.length) fail('cut off inside entry ' + i);
        const h16 = b.slice(off, off + 16); head.set(b.subarray(off, off + ENT)); off += ENT;
        const type = head[0], pl = view.getUint16(off - ENT + 2, true), gl = view.getUint16(off - ENT + 4, true);
        const size = Number(le(head, 8, 8)), mt = Number(le(head, 16, 8));
        if (type !== 1 && type !== 2) fail('entry ' + i + ': unknown type ' + type);
        if (!pl || (type === 1 && size)) fail('entry ' + i + ': bad path length');
        if (off + pl + gl > b.length) fail('cut off in entry ' + i + ' names');
        const pathB = b.slice(off, off + pl), guestB = b.slice(off + pl, off + pl + gl), guest = dec.decode(guestB); off += pl + gl;
        const path = dec.decode(pathB);
        if (path.indexOf('\0') >= 0 || !pathOk(path)) fail('entry ' + i + ': path leaves the save (' + path + ')');
        if (off + size > b.length - END.length) fail('cut off in entry ' + i + ' contents');
        const data = type === 2 ? b.slice(off, off + size) : u8(0); off += size;
        push(h16); push(pathB); if (gl) push(guestB); push(data);
        entries.push({ type: type === 2 ? 'file' : 'dir', path, guest, mtime: mt, size, bytes: data }); files += type === 2 ? 1 : 0;
      }
      if (off !== b.length - END.length) fail((b.length - END.length - off) + ' unexpected bytes before the end marker');
      const hash = files ? await sha16hex(run) : '';
      if (hash !== want) fail('hash mismatch: the file is damaged (header says ' + want + ', contents give ' + hash + ')');
      return { version, title, device, saved, hash, entries, files };
    }
    const byteLess = (a, c) => { const x = enc.encode(a), y = enc.encode(c); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
    async function write(save, meta) {
      const kids = {};
      for (const p of Object.keys(save)) {
        if (!pathOk(p)) throw new Error('refusing to pack a path outside the save: ' + p);
        if (p.split('/').includes('.DS_Store')) continue;
        const parent = p.slice(0, p.lastIndexOf('/')); (kids[parent] ||= []).push(p.slice(parent.length + 1));
      }
      for (const k of Object.keys(kids)) kids[k].sort((a, c) => byteLess(a, c));
      const hasAny = (dir) => (kids[dir] || []).some((nm) => { const p = dir + '/' + nm; return p.split('/').pop() !== '.DS_Store' && (save[p].type === 'file' || hasAny(p)); });
      const run = [], out = [], order = [];
      const emit = (path) => {
        const e = save[path]; if (!e || e.name === '.DS_Store') return;
        const pathB = enc.encode(path), guestB = e.guest ? enc.encode(e.guest) : u8(0);
        if (pathB.length > 0xffff || guestB.length > 0xffff) throw new Error('name too long: ' + path);
        const file = e.type === 'file', data = file ? e.bytes : u8(0);
        const h = u8(ENT); h[0] = file ? 2 : 1; putLe(h, 2, pathB.length, 2); putLe(h, 4, guestB.length, 2);
        putLe(h, 8, file ? data.length : 0n, 8); putLe(h, 16, BigInt(Math.round(e.mtime)), 8);
        run.push(h.subarray(0, 16), pathB); if (guestB.length) run.push(guestB); if (data.length) run.push(data);
        out.push(h, pathB, guestB, data); order.push({ path, type: file ? 'file' : 'dir', size: data.length, mtime: e.mtime, guest: e.guest || '' });
        if (!file) for (const nm of (kids[path] || [])) emit(path + '/' + nm);
      };
      for (const rootDir of FOLDERS) if (hasAny(rootDir)) for (const nm of (kids[rootDir] || [])) emit(rootDir + '/' + nm);
      const hash = order.some((e) => e.type === 'file') ? await sha16hex(run) : '';
      let saved = 0; for (const e of order) if (e.type === 'file' && e.mtime > saved) saved = e.mtime;
      const hdr = u8(HDR); hdr.set(MAGIC, 0); putLe(hdr, 8, 1, 4); putLe(hdr, 12, order.length, 4);
      hdr.set(enc.encode(hash).subarray(0, HASHCH), 16); putLe(hdr, 48, BigInt(saved), 8);
      hdr.set(enc.encode((meta.title || '').toUpperCase()).subarray(0, 23), 56);
      hdr.set(enc.encode(meta.device || 'unknown').subarray(0, 63), 80);
      const parts = [hdr, ...out, u8(END.length)]; parts[parts.length - 1].set(END, 0);
      const total = parts.reduce((s, p) => s + p.length, 0), buf = u8(total);
      let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
      return { bytes: buf, hash, saved, entries: order, files: order.filter((e) => e.type === 'file').length };
    }
    function fromBundle(b) { const s = {}; for (const e of b.entries) s[e.path] = { type: e.type, guest: e.guest, mtime: e.mtime, bytes: e.bytes }; return s; }
    return { read, write, fromBundle, pathOk, HDR, ENT };
  })();

  // ============================ Three Houses save file ============================
  /* Layout, in bytes from the 12-byte file header (the "body"):
        body +0x0000   item box, 400 x { i16 id (-1 = empty), u8 durability, u8 amount }
        body +0x0640   u32 number of used item boxes
        body +0x0644   60 unit records, stride 0x24C (v1.1.0 saves: 0x230)
        body +0x9014   player name, 0x28 bytes, wrapped in {esc}N0 ... {esc}N1
        body +0x904C   unit-support/quest table the game owns (left alone)
        body +0x231D9  player block: barracks 200x8 at +0xA30, playtime +0x1070, gold +0x1074,
                       chapter +0x107C, support values u16[270] +0x1080, difficulty/style/route +0x129C
        body +0x250A1  activity block: reputation +0xC, instruct exp +0x12, activity counts +0x27, statues +0x2B
     File header: u32 byte-sum of the body, u32 save version (23 = game 1.1.0/1.2.0), u32 file size.
     Offsets verified against a real 1.2.0 save: playtime here matches save/system, and every
     field probed (item durabilities, empty-magic marker 38, motivation 50, 200 empty barracks
     slots) reads back as the game would write it. */
  const BODY = 12;
  const L = {
    itemBox: 0x0000, itemCount: 0x0640, items: 400, itemSize: 4,
    units: 0x0644, unitCount: 60, unitSizeNew: 0x24C, unitSizeOld: 0x230,
    playerName: 0x9014,
    playerNew: 0x231D9, playerOld: 0x22B49, playerSize: 0x1EC8,
    activitiesNew: 0x250A1, activitiesOld: 0x24A11, activitySize: 0x56A,
  };
  const P = { barracks: 0xA30, playtime: 0x1070, gold: 0x1074, chapter: 0x107C, supports: 0x1080, supportCount: 270, flags: 0x129C };
  const A = { reputation: 0xC, instructExp: 0x12, activity: 0x27, statues: 0x2B };

  const bodySum = (bytes) => { let s = 0; for (let i = BODY; i < bytes.length; i++) s = (s + bytes[i]) >>> 0; return s >>> 0; };

  class Save {
    constructor(bytes, name) {
      this.name = name || 'save';
      // refuse the other game by name rather than parsing it into nonsense (gold 0, playtime 83886080)
      if (!looksLikeSave(bytes) && looksLikeOtherGame(bytes)) throw new Error(OTHER_GAME + ' save, not Three Houses');
      this.bytes = bytes.slice();                       // never touch the caller's buffer
      this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
      this.checksum = this.view.getUint32(0, true);
      this.version = this.view.getUint32(4, true);
      this.fileSize = this.view.getUint32(8, true);
      this.bodyLen = this.bytes.length - BODY;
      this.ok = this.bodySumMatches();
      // 1.2.0 (0x25B20) and 1.0.x (0x25400) differ only in record size / block positions
      this.newLayout = this.bodyLen >= 0x25B20;
      this.unitSize = this.newLayout ? L.unitSizeNew : L.unitSizeOld;
      this.playerBase = (this.newLayout ? L.playerNew : L.playerOld);
      this.activityBase = (this.newLayout ? L.activitiesNew : L.activitiesOld);
      this.supportsLayout = this.version >= 20;
      this.edits = [];                                   // {what, before, after} for the diff list
    }
    bodySumMatches() { return bodySum(this.bytes) === this.checksum; }
    // ---- primitives -------------------------------------------------------
    g(rel, n) { const o = BODY + rel; return n === 1 ? this.bytes[o] : n === 2 ? this.view.getUint16(o, true) : n === 4 ? this.view.getUint32(o, true) : Number(this.view.getBigInt64(o, true)); }
    gi(rel, n) { const o = BODY + rel; return n === 1 ? this.bytes[o] << 24 >> 24 : n === 2 ? this.view.getInt16(o, true) : this.view.getInt32(o, true); }
    s(rel, n, v) {
      const o = BODY + rel;
      if (n === 1) this.bytes[o] = v & 0xff; else if (n === 2) this.view.setUint16(o, v & 0xffff, true); else this.view.setUint32(o, v >>> 0, true);
    }
    si(rel, n, v) { const o = BODY + rel; if (n === 1) this.bytes[o] = v & 0xff; else if (n === 2) this.view.setInt16(o, v, true); else this.view.setInt32(o, v, true); }
    bytesAt(rel, n) { return this.bytes.subarray(BODY + rel, BODY + rel + n); }
    hexAt(rel, n) { return [...this.bytesAt(rel, n)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
    // ---- player -----------------------------------------------------------
    get playtime() { return this.g(this.playerBase + P.playtime, 4); }
    get gold() { return this.g(this.playerBase + P.gold, 4); }
    get chapter() { return this.g(this.playerBase + P.chapter, 4); }
    get difficulty() { return this.bytes[BODY + this.playerBase + P.flags]; }
    get gameStyle() { return this.bytes[BODY + this.playerBase + P.flags + 1]; }
    get route() { return this.bytes[BODY + this.playerBase + P.flags + 2]; }
    get mapId() { return this.bytes[BODY + this.playerBase + P.flags + 4]; }
    playerName() {
      const raw = this.bytesAt(L.playerName, 0x28); let end = 0; while (end < raw.length && raw[end]) end++;
      return new TextDecoder('utf-8').decode(raw.subarray(0, end)).replace(/\u001bN\d/g, '');
    }
    setPlayerName(text) {
      const tag = (t) => new TextEncoder().encode('\u001bN' + t);
      const name = new TextEncoder().encode(String(text).replace(/[\u001b\u0000]/g, '').slice(0, 20));
      this.bytes.fill(0, BODY + L.playerName, BODY + L.playerName + 0x28);
      let o = BODY + L.playerName;
      this.bytes.set(tag('0'), o); o += 3; this.bytes.set(name, o); o += name.length; this.bytes.set(tag('1'), o);
    }
    barracks(i) { const b = this.playerBase + P.barracks + i * 8; return { owner: this.gi(b, 2), exp: this.g(b + 2, 2), stamina: this.g(b + 4, 2), type: this.g(b + 6, 1), skill: this.g(b + 7, 1) }; }
    setBarracks(i, f) { const b = this.playerBase + P.barracks + i * 8; this.si(b, 2, f.owner); this.s(b + 2, 2, f.exp); this.s(b + 4, 2, f.stamina); this.s(b + 6, 1, f.type); this.s(b + 7, 1, f.skill); }
    support(i) { return this.g(this.playerBase + P.supports + 2 * i, 2); }
    setSupport(i, v) { this.s(this.playerBase + P.supports + 2 * i, 2, v); }
    // ---- activities -------------------------------------------------------
    get reputation() { return this.g(this.activityBase + A.reputation, 4); }
    get instructExp() { return this.g(this.activityBase + A.instructExp, 2); }
    // ---- item box ---------------------------------------------------------
    item(i) { const b = L.itemBox + i * L.itemSize; return { id: this.gi(b, 2), dur: this.g(b + 2, 1), amount: this.g(b + 3, 1) }; }
    setItem(i, f) { const b = L.itemBox + i * L.itemSize; this.si(b, 2, f.id); this.s(b + 2, 1, f.dur); this.s(b + 3, 1, f.amount); }
    // ---- unit record ------------------------------------------------------
    unit(i) {
      const r = L.units + i * this.unitSize;
      const u8 = (o) => this.g(r + o, 1), i8 = (o) => this.gi(r + o, 1), u16 = (o) => this.g(r + o, 2), i16 = (o) => this.gi(r + o, 2);
      const u = {
        slot: i, addr: r,
        items: Array.from({ length: 6 }, (_, k) => ({ id: i16(4 * k), dur: u8(4 * k + 2), amount: u8(4 * k + 3) })),
        battalion: { owner: i16(0x18), exp: u16(0x1A), stamina: u16(0x1C), type: u8(0x1E), skill: u8(0x1F) },
        id: i16(0x24), exp: u16(0x2C),
        equipped: [i16(0x2E), i16(0x30)],
        skillExp: Array.from({ length: 11 }, (_, k) => u16(0x32 + 2 * k)),
        classExp: u16(0x48), level: u8(0x4A), class: u8(0x4B), hp: u8(0x4C), unk4D: u8(0x4D),
        stats: { str: u8(0x4E), mag: u8(0x4F), dex: u8(0x50), spd: u8(0x51), lck: u8(0x52), def: u8(0x53), res: u8(0x54), mov: u8(0x55), cha: u8(0x56) },
        artsKnown: Array.from({ length: 10 }, (_, k) => u8(0x57 + k)),
        abilities: (() => { const a = []; for (let k = 0; k < 30; k++) { const v = u8(0x61 + k); for (let bit = 0; bit < 8; bit++) a.push((v >> bit) & 1); } return a; })(),
        abilitiesRaw: Array.from({ length: 30 }, (_, k) => u8(0x61 + k)),
        abilitiesEquipped: Array.from({ length: 5 }, (_, k) => u8(0x7F + k)),
        artsEquipped: Array.from({ length: 3 }, (_, k) => u8(0x84 + k)),
        itemCount: u8(0x87),
        skillRanks: Array.from({ length: 11 }, (_, k) => u8(0x88 + k)),
        classLevel: u8(0x93),
        magicDurability: Array.from({ length: 12 }, (_, k) => u8(0x94 + k)),
        magicKnown: Array.from({ length: 12 }, (_, k) => u8(0xA0 + k)),
        motivation: u8(0xC4),
        learningFocus: u8(0xDB), classFlags: u8(0xDF), adjutant: i16(0xFA),
        classExpAll: Array.from({ length: 64 }, (_, k) => u16(0x112 + 2 * k)),
        classUnlockFlags: Array.from({ length: 8 }, (_, k) => u8(0xD3 + k)),
        deployIndex: u8(0x1B0 + 0x16), deploySlot: u8(0x1B0 + 0x17),
        classLevelsAll: Array.from({ length: 64 }, (_, k) => u8(0x1B0 + 0x23 + k)),
      };
      u.skills = Array.from({ length: 11 }, (_, k) => ({ exp: u.skillExp[k], rank: u.skillRanks[k] }));
      u.flags = this.g(r + 0xAC, 4);
      return u;
    }
    // write only the listed fields of a unit record, so unknown bytes stay untouched.
    // patch keys may be nested (stats:{str:20}, items:[{id:...}]) or dotted ("stats.str").
    setUnit(i, patch) {
      const flat = {};
      const walk = (obj, pre) => {
        for (const [k, v] of Object.entries(obj)) {
          // numeric keys become [n] (array slots in the record); named keys stay dotted
          const path = pre ? (/^\d+$/.test(k) ? pre + '[' + k + ']' : pre + '.' + k) : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
          else if (Array.isArray(v)) v.forEach((x, n) => (x && typeof x === 'object' ? walk(x, path + '[' + n + ']') : flat[path + '[' + n + ']'] = x));
          else flat[path] = v;
        }
      };
      walk(patch, '');
      const r = L.units + i * this.unitSize;
      const chk = (o) => { if (typeof o !== 'number' || Number.isNaN(o) || o < 0 || o >= this.unitSize) throw new Error('setUnit: unhandled field offset (' + o + ')'); return o; };
      const set = (o, n, v) => { o = chk(o); return n === 1 ? this.s(r + o, 1, v) : n === 2 ? this.s(r + o, 2, v) : this.s(r + o, 4, v); };
      const seti = (o, n, v) => { o = chk(o); return n === 1 ? (this.bytes[BODY + r + o] = v & 0xff) : n === 2 ? this.si(r + o, 2, v) : this.si(r + o, 4, v); };
      for (const [path, value] of Object.entries(flat)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(-?\d+)\])?(?:\.(.+))?$/.exec(path);
        const key = m[1], idx = m[2] === undefined ? -1 : +m[2], sub = m[3];
        const S = (o, n) => set(o, n, value);
        switch (key) {
          case 'id': seti(0x24, 2, value); break;
          case 'exp': set(0x2C, 2, value); break;
          case 'equipped': set(0x2E + 2 * idx, 2, value); break;
          case 'level': S(0x4A, 1); break;
          case 'class': S(0x4B, 1); break;
          case 'hp': S(0x4C, 1); break;
          case 'classExp': S(0x48, 2); break;
          case 'classLevel': S(0x93, 1); break;
          case 'motivation': S(0xC4, 1); break;
          case 'learningFocus': S(0xDB, 1); break;
          case 'classFlags': S(0xDF, 1); break;
          case 'itemCount': S(0x87, 1); break;
          case 'adjutant': seti(0xFA, 2, value); break;
          case 'unk4D': S(0x4D, 1); break;
          case 'flags': this.s(r + 0xAC, 4, value); break;
          case 'stats': S(({ str: 0x4E, mag: 0x4F, dex: 0x50, spd: 0x51, lck: 0x52, def: 0x53, res: 0x54, mov: 0x55, cha: 0x56 })[sub], 1); break;
          case 'items': this.si(r + 4 * idx + (sub === 'dur' ? 2 : sub === 'amount' ? 3 : 0), sub === 'id' ? 2 : 1, value); break;
          case 'battalion': { const o = { owner: 0x18, exp: 0x1A, stamina: 0x1C, type: 0x1E, skill: 0x1F }[sub]; (sub === 'owner' ? seti : set)(o, sub === 'owner' ? 2 : (sub === 'type' || sub === 'skill') ? 1 : 2, value); break; }
          case 'skillExp': set(0x32 + 2 * idx, 2, value); break;
          case 'skillRanks': S(0x88 + idx, 1); break;
          case 'skill': set(0x32 + 2 * idx, 2, value.exp); S(0x88 + idx, 1, value.rank); break;
          case 'artsKnown': S(0x57 + idx, 1); break;
          case 'artsEquipped': S(0x84 + idx, 1); break;
          case 'magicKnown': S(0xA0 + idx, 1); break;
          case 'magicDurability': S(0x94 + idx, 1); break;
          case 'abilities': { const byte = this.bytes[BODY + r + 0x61 + (idx >> 3)]; this.bytes[BODY + r + 0x61 + (idx >> 3)] = value ? byte | (1 << (idx & 7)) : byte & ~(1 << (idx & 7)); break; }
          case 'abilitiesEquipped': S(0x7F + idx, 1); break;
          case 'classExpAll': set(0x112 + 2 * idx, 2, value); break;
          case 'classUnlockFlags': S(0xD3 + idx, 1); break;
          case 'classLevelsAll': S(0x1B0 + 0x23 + idx, 1); break;
          case 'deployIndex': S(0x1B0 + 0x16, 1); break;
          case 'deploySlot': S(0x1B0 + 0x17, 1); break;
          default: throw new Error('setUnit: unknown field ' + path);
        }
      }
    }
    // ---- finish -----------------------------------------------------------
    seal() { this.view.setUint32(0, bodySum(this.bytes), true); this.checksum = this.view.getUint32(0, true); return this.bytes; }
  }

  function looksLikeSave(bytes) {
    if (bytes.length < BODY + 0x100) return false;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = v.getUint32(8, true), ver = v.getUint32(4, true);
    return size === bytes.length && (ver === 23 || ver === 13 || ver === 12) && (size === 0x25B2C || size === 0x2540C);
  }
  const looksLikeSystemSave = (bytes) => bytes.length > 16 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true) === bytes.length && bytes.length < 0x4000;

  // ---- refusing the other game ---------------------------------------------
  /* Both titles travel in the same .dmsync container, so an Engage container opens happily here and the
     saves inside are the only thing that says which game they belong to. Engage marks itself: its section
     index starts with the "EDNI" magic, at 0 in a Global save and at 0x80 in a game save. Silently
     skipping such a file reads as "opened fine, 0 saves", which looks like a bug in this page. */
  const OTHER_GAME = 'Fire Emblem Engage';
  function looksLikeOtherGame(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!b || b.length < 0x84) return false;
    const at = (o) => b[o] === 0x45 && b[o + 1] === 0x44 && b[o + 2] === 0x4e && b[o + 3] === 0x49;   // E D N I
    return at(0) || at(0x80);
  }
  // a container belongs to the other game when nothing in it is ours and something in it is theirs
  function containerHoldsOtherGame(b) {
    let mine = 0, theirs = 0;
    for (const e of b.entries) {
      if (e.type !== 'file') continue;
      if (looksLikeSave(e.bytes)) mine++; else if (looksLikeOtherGame(e.bytes)) theirs++;
    }
    return !mine && theirs ? OTHER_GAME : null;
  }
  // why a dropped file was skipped, naming the game when we can tell which one it is
  const wrongGameNote = (bytes) => looksLikeOtherGame(bytes)
    ? OTHER_GAME + ' save - this page edits Three Houses, so it was skipped'
    : 'not a Three Houses save file, skipped';

  // save/system: 0x70-byte slot records from 0x38. Only records that carry a real save version
  // are decoded; the rest is left as raw bytes (it is metadata the game owns).
  function readSystemSlots(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    for (let o = 0x38; o + 0x70 <= bytes.length; o += 0x70) {
      const raw = bytes.subarray(o, o + 0x28); let e = 0; while (e < raw.length && raw[e]) e++;
      const name = new TextDecoder('utf-8').decode(raw.subarray(0, e)).replace(/\u001bN\d/g, '');
      const version = v.getUint32(o + 0x58, true);
      if (![12, 13, 23].includes(version)) continue;
      out.push({ addr: o, name, playtime: v.getUint32(o + 0x4C, true), value50: v.getUint32(o + 0x50, true), value54: v.getUint32(o + 0x54, true), version });
    }
    return out;
  }

  const fmtTime = (s) => Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm';
  const TAG = '\u001b';

  const api = { DMS, Save, looksLikeSave, looksLikeSystemSave, readSystemSlots, bodySum, fmtTime, L, P, A, TAG,
    OTHER_GAME, looksLikeOtherGame, containerHoldsOtherGame, wrongGameNote };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FE3H = api;
})(typeof window !== 'undefined' ? window : globalThis);
