/* Fire Emblem Engage save codec: nxnative .dmsync container + Engage save file structure.
   Loads in a browser (window.FEE) and in node (module.exports) so the same code is testable.

   Layout, all verified against a real v2.0.0 save (format version 9):

     .dmsync            nxnative packed save: DMSYNC1 header, 24-byte entries, SHA-256, DMSYNCE tail.
                        Same shape as the Three Houses one. save/Auto, save/Manual0… and save/Global
                        live inside it.

     save file          header (128 bytes) · section index · sections · "LVRC" · crc32
       +0x00  u32       format version (9 = game 1.0 through 2.0)
       +0x04  u32       game version (304 = 2.0.0)
       +0x08  u32       status (2 in a normal in-progress save)
       +0x0C  u8,u32    chapter encoding marker (2) + hash of the current chapter id ("CID_M007")
       +0x11  u8,u32    same, for the next chapter
       +0x16  u16       sequence (save counter)
       +0x17  u8        difficulty (0 Normal, 1 Hard, 2 Maddening)
       +0x19  u8        game mode (0 Casual, 1 Classic)
       +0x1A  u32       a per-save counter (turn-like; read only)
       +0x28  f32       playtime in seconds
       +0x42  u32       crc32 of the header bytes before it - recomputed on every write
       +0x80  "EDNI"    section index: magic + 32 u32 offsets, one per section boundary
       end-8  "LVRC"    footer magic
       end-4  u32       crc32 of everything before it - recomputed on every write

     sections           4-character tag + u32 size (covering itself and the payload) + payload. Tags in
                        a game save (the tag bytes are stored reversed, so "USER" reads "RESU"):
                          USER  player settings, game variables, money, Sommie's name
                          GDBD  Emblem bond holders: per Emblem, per character bond level and exp
                          GOD   owned Emblems (instance, dirtiness, Engage+ synchro, reserved weapons)
                          RING  bond ring pool (instance, ring hash, stock)
                          UNIT  unit pools: player / enemy / ally / absent / dead / lost / temporary
                          TRAN  the convoy (999 slots)
                          UREL  character supports (rank, points, score)
                          PROF  profile and achievements
                          PROL  small profile block
                          TIME  playtime (mirror of the header copy)
                          REST  the big one: story and event flags (left alone here)
                          MAP   map edit/history data (left alone here)
                        A Global save is the same container with the index at +0x00 instead of +0x80.

     references         an optional game-data reference is u16 0xccdb (none) or u16 0xefcd + u32 hash,
                        where hash is FNV-1a/32 over the UTF-16 code units of the game's own id string
                        (the ids are Japanese, e.g. "IID_はがねのつるぎ" = Steel Sword). Strings are
                        u32 byte length (0xffffffff = null) followed by UTF-16LE.
     Versions and record lengths are checked as the codec reads, so a save this codec cannot explain is
     an error rather than a misread. Every write re-parses the result and compares the value it wrote. */
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

  // ============================ hashes and byte helpers ============================
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let v = n; for (let b = 0; b < 8; b++) v = v & 1 ? (0xedb88320 ^ (v >>> 1)) >>> 0 : v >>> 1; t[n] = v >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0; return (~c) >>> 0; }

  // FNV-1a/32 over UTF-16 code units - the game's own string hash (see the header comment).
  function fnv1a(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h = Math.imul(h, 16777619) >>> 0; h = (h ^ s.charCodeAt(i)) >>> 0; } return h >>> 0; }

  const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const tagAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const dec16 = new TextDecoder('utf-16le');
  function utf16Bytes(text) { const out = new Uint8Array(text.length * 2); for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8; } return out; }
  const strFrom16 = (bytes) => (bytes.length ? dec16.decode(bytes) : '');
  const cat = (parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  function u32bytes(v) { const a = new Uint8Array(4); a[0] = v & 0xff; a[1] = (v >>> 8) & 0xff; a[2] = (v >>> 16) & 0xff; a[3] = (v >>> 24) & 0xff; return a; }
  const u16bytes = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const hex4 = (n) => '0x' + n.toString(16).padStart(4, '0');
  const hexoff = (n) => '0x' + n.toString(16);

  const NONE_REF = 0xccdb, SOME_REF = 0xefcd;
  const encRef = (hash) => (hash === null || hash === undefined)
    ? u16bytes(NONE_REF)
    : cat([u16bytes(SOME_REF), u32bytes(hash >>> 0)]);
  const encStr = (s) => { const body = utf16Bytes(s); return cat([u32bytes(body.length), body]); };

  // ============================ sequential reader over the save bytes ============================
  class R {
    constructor(bytes, pos, end) { this.b = bytes; this.pos = pos; this.end = end === undefined ? bytes.length : end; this.tag = 'data'; }
    get remaining() { return this.end - this.pos; }
    skip(n) { if (n < 0 || n > this.remaining) throw new Error('a field in the ' + this.tag + ' block runs past its end (at ' + hexoff(this.pos) + ')'); this.pos += n; return this; }
    byte() { const o = this.pos; this.skip(1); return this.b[o]; }
    u16() { const o = this.pos; this.skip(2); return this.b[o] | (this.b[o + 1] << 8); }
    u32() { const o = this.pos; this.skip(4); return rd32(this.b, o); }
    i32() { return this.u32() | 0; }
    f32() { const o = this.pos; this.skip(4); return new DataView(this.b.buffer, this.b.byteOffset + o, 4).getFloat32(0, true); }
    ref() {
      const t = this.u16();
      if (t === NONE_REF) return null;
      if (t === SOME_REF) return this.u32();
      throw new Error('unknown reference marker ' + hex4(t) + ' at ' + hexoff(this.pos - 2) + ' in the ' + this.tag + ' block');
    }
    str(max = 4096) {
      const len = this.u32();
      if (len === 0xffffffff) return null;
      if (len > max || (len & 1)) throw new Error('bad UTF-16 string length ' + len + ' at ' + hexoff(this.pos - 4) + ' in the ' + this.tag + ' block');
      const s = strFrom16(this.b.subarray(this.pos, this.pos + len)); this.skip(len); return s;
    }
    want(v, what) { const got = this.u32(); if (got !== v) throw new Error('unsupported ' + what + ' (found ' + got + ', expected ' + v + ') at ' + hexoff(this.pos - 4)); return got; }
    wantByte(v, what) { const got = this.byte(); if (got !== v) throw new Error('unsupported ' + what + ' (found ' + got + ', expected ' + v + ') at ' + hexoff(this.pos - 1)); return got; }
  }

  // an item slot: {u32 version 5}{u8 present}{ ref item, u8 uses, u8 refine, u32 flags, ref engraving }
  const ITEM_VERSION = 5;
  function encItem(item) {
    if (!item) return cat([u32bytes(ITEM_VERSION), new Uint8Array([0])]);
    return cat([u32bytes(ITEM_VERSION), new Uint8Array([1]), encRef(item.hash),
      new Uint8Array([item.uses & 0xff, item.refine & 0xff]), u32bytes(item.flags >>> 0), encRef(item.engrave)]);
  }
  function readItem(r) {
    r.want(ITEM_VERSION, 'item version');
    const present = r.byte();
    if (present > 1) throw new Error('bad item presence flag ' + present + ' at ' + hexoff(r.pos - 1));
    if (!present) return null;
    const hash = r.ref();
    if (hash === null) throw new Error('an occupied item slot has no item at ' + hexoff(r.pos));
    const uses = r.byte(), refine = r.byte(), flags = r.u32(), engrave = r.ref();
    return { hash, uses, refine, flags, engrave };
  }

  // ============================ the save file ============================
  const H = {
    format: 0x00, gameVersion: 0x04, status: 0x08, chapterMark: 0x0c, chapterHash: 0x0d,
    nextChapterMark: 0x11, nextChapterHash: 0x12, sequence: 0x16, difficulty: 0x17, gameMode: 0x19,
    counter: 0x1a, playtime: 0x28, index: 0x80,
  };
  const INDEX_SIZE = 132;                  // "EDNI" + 32 u32 offsets
  const RING_POOL = { version: 3, max: 750, maxUnequipped: 700, maxEquipped: 50, stockMax: 99 };
  const POOL_MAGIC = 0xcdcdcdcd;
  const MATERIAL_KEYS = ['G_所持_IID_てつの晶石', 'G_所持_IID_はがねの晶石', 'G_所持_IID_ぎんの晶石'];
  const QTY_PREFIX = 'G_所持_';
  const STAT_NAMES = ['HP', 'Strength', 'Dexterity', 'Speed', 'Luck', 'Defense', 'Magic', 'Resistance', 'Build', 'Sight', 'Movement'];
  const WEAPON_TYPES = [null, 'Sword', 'Lance', 'Axe', 'Bow', 'Dagger', 'Magic', 'Staff', 'Combat Art', 'Special'];
  const FORCES = ['Player', 'Enemy', 'Ally', 'Absent', 'Dead', 'Lost', 'Temporary'];
  const DIFFICULTY = ['Normal', 'Hard', 'Maddening'];
  const GAME_MODE = ['Casual', 'Classic'];
  const SUPPORT_RANK = ['None', 'C', 'B', 'A', 'Pact'];

  class Save {
    constructor(bytes, name, knownHdrCrc) {
      this.name = name || 'save';
      this.bytes = bytes.slice();               // never touch the caller's buffer
      this.hdrCrcOffset = knownHdrCrc === undefined ? null : knownHdrCrc;
      this.parse();
    }

    // ---- container structure -------------------------------------------------
    parse() {
      const b = this.bytes;
      if (b.length < INDEX_SIZE + 8) throw new Error('too short to be an Engage save (' + b.length + ' bytes)');
      if (!looksLikeSave(b) && looksLikeOtherGame(b)) throw new Error(OTHER_GAME + ' save, not Engage');   // rather than "no section index"
      if (tagAt(b, 0) === 'EDNI') { this.kind = 'global'; this.indexOffset = 0; }
      else if (b.length >= H.index + INDEX_SIZE + 8 && tagAt(b, H.index) === 'EDNI') { this.kind = 'game'; this.indexOffset = H.index; }
      else throw new Error('no Engage section index found (looked for the EDNI magic at 0 and at 0x80)');
      const footer = b.length - 4;
      if (tagAt(b, footer - 4) !== 'LVRC') throw new Error('no LVRC checksum footer, so this is not a file the game wrote');
      this.storedCrc = rd32(b, footer);
      this.crcOk = this.storedCrc === crc32(b.subarray(0, footer));
      this.formatVersion = this.kind === 'game' ? rd32(b, H.format) : null;
      this.gameVersion = this.kind === 'game' ? rd32(b, H.gameVersion) : null;

      const offsets = []; let ended = false;
      for (let slot = 0; slot < 32; slot++) {
        const v = rd32(b, this.indexOffset + 4 + slot * 4);
        if (!v) { ended = true; continue; }
        if (ended || v > footer - 4) throw new Error('section index slot ' + slot + ' points at ' + hexoff(v) + ', which is not a section start');
        offsets.push(v);
      }
      if (offsets.length < 2) throw new Error('the section index names no sections');
      if (offsets[0] !== this.indexOffset + INDEX_SIZE) throw new Error('the first section should start at ' + hexoff(this.indexOffset + INDEX_SIZE) + ' but the index says ' + hexoff(offsets[0]));
      if (offsets[offsets.length - 1] !== footer - 4) throw new Error('the section index does not run up to the checksum footer');
      this.sections = [];
      for (let i = 0; i < offsets.length - 1; i++) {
        const a = offsets[i], z = offsets[i + 1];
        const name = String.fromCharCode(b[a + 3], b[a + 2], b[a + 1], b[a]).trimEnd();
        for (let k = 0; k < 4; k++) if (b[a + k] < 0x20 || b[a + k] > 0x7e) throw new Error('the section tag at ' + hexoff(a) + ' is not printable');
        const size = rd32(b, a + 4);
        if (z - a < 8 || size !== z - a - 4) throw new Error('section ' + name + ' at ' + hexoff(a) + ' has a size word that does not match its place in the index');
        this.sections.push({ name, off: a, len: z - a - 8, payload: a + 8 });
      }
      // The header keeps a crc32 of its own earlier bytes. Find it by looking for the one word in the
      // header that equals the crc32 of everything before it (in a real save that is 0x42).
      if (this.kind === 'game') {
        if (this.hdrCrcOffset === null) {
          const found = [];
          for (let o = 26; o <= 124; o++) if (rd32(b, o) === crc32(b.subarray(0, o))) found.push(o);
          if (!found.length) throw new Error('the header checksum in this save does not match its own bytes (the file may be damaged)');
          this.hdrCrcOffset = found[0];
        }
        this.hdrCrcOk = rd32(b, this.hdrCrcOffset) === crc32(b.subarray(0, this.hdrCrcOffset));
      }
      return this;
    }

    section(name) {
      const hits = this.sections.filter((s) => s.name === name);
      if (hits.length !== 1) throw new Error('expected exactly one ' + name + ' section, this save has ' + hits.length);
      return hits[0];
    }
    hasSection(name) { return this.sections.some((s) => s.name === name); }
    sectionAt(abs) { return this.sections.find((s) => abs >= s.payload && abs <= s.payload + s.len) || null; }
    reader(section, tag) { const r = new R(this.bytes, section.payload, section.payload + section.len); r.tag = tag || section.name; return r; }
    dv() { return new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength); }

    // ---- writing -------------------------------------------------------------
    // Replace a range of bytes inside one section, growing or shrinking it, and keep the section's own
    // size word, every later section's place in the index and both checksums correct.
    splice(start, end, replacement) {
      const sec = this.sectionAt(start);
      if (!sec) throw new Error(hexoff(start) + ' is not inside a section, so it cannot be resized');
      if (end > sec.payload + sec.len) throw new Error('a replacement may not cross out of its section');
      const delta = replacement.length - (end - start);
      this.bytes = cat([this.bytes.subarray(0, start), replacement, this.bytes.subarray(end)]);
      const dv = this.dv();
      dv.setUint32(sec.off + 4, sec.len + delta + 4, true);
      for (let slot = 0; slot < 32; slot++) {
        const at = this.indexOffset + 4 + slot * 4, v = dv.getUint32(at, true);
        if (v > sec.off) dv.setUint32(at, v + delta, true);
      }
      this.parse();
      const me = this.sections.find((s) => s.name === sec.name && s.len === sec.len + delta);
      if (!me) throw new Error('self check: ' + sec.name + ' is not ' + (sec.len + delta) + ' bytes after the write');
      this.seal();
      return delta;
    }
    // Recompute the header checksum, then the whole-file checksum.
    seal() {
      const dv = this.dv();
      if (this.kind === 'game' && this.hdrCrcOffset !== null) dv.setUint32(this.hdrCrcOffset, crc32(this.bytes.subarray(0, this.hdrCrcOffset)), true);
      dv.setUint32(this.bytes.length - 4, crc32(this.bytes.subarray(0, this.bytes.length - 4)), true);
      this.storedCrc = dv.getUint32(this.bytes.length - 4, true);
      this.crcOk = true;
      this.hdrCrcOk = this.kind !== 'game' || (this.hdrCrcOffset !== null && dv.getUint32(this.hdrCrcOffset, true) === crc32(this.bytes.subarray(0, this.hdrCrcOffset)));
      return this.bytes;
    }
    // Re-read the whole file the same way an untouched save is read, and check the parts that must hold.
    verifyRead(what) {
      const s = new Save(this.bytes, this.name, this.hdrCrcOffset);
      if (!s.crcOk) throw new Error('self check: the edited ' + this.name + ' does not carry a matching checksum');
      if (!s.hdrCrcOk) throw new Error('self check: the header checksum of the edited ' + this.name + ' is stale');
      s.roster && s.hasSection('UNIT') && s.roster();
      void what;
      return s;
    }

    // ---- header (game saves) -------------------------------------------------
    header() {
      if (this.kind !== 'game') return null;
      const dv = this.dv(), b = this.bytes;
      return {
        formatVersion: this.formatVersion, gameVersion: this.gameVersion,
        status: dv.getUint32(H.status, true),
        chapterMark: b[H.chapterMark], chapterHash: dv.getUint32(H.chapterHash, true),
        nextChapterMark: b[H.nextChapterMark], nextChapterHash: dv.getUint32(H.nextChapterHash, true),
        sequence: dv.getUint16(H.sequence, true), difficulty: b[H.difficulty], gameMode: b[H.gameMode],
        counter: dv.getUint32(H.counter, true), playtime: dv.getFloat32(H.playtime, true),
        hdrCrcOffset: this.hdrCrcOffset,
      };
    }
    setPlaytime(seconds) {
      if (!(seconds >= 0 && seconds <= 3599999.5)) throw new Error('play time must be between 0 and 3599999.5 seconds');
      const sec = this.section('TIME');
      if (sec.len !== 40) throw new Error('the TIME section is ' + sec.len + ' bytes, expected 40');
      const dv = this.dv();
      dv.setFloat32(H.playtime, seconds, true);
      dv.setFloat32(sec.payload + 32, seconds, true);
      this.seal();
      if (this.header().playtime !== seconds) throw new Error('self check: play time did not survive the write');
      this.verifyRead('playtime');
    }
    setDifficulty(value) { this.setHeaderSettings(value, null); }
    setGameMode(value) { this.setHeaderSettings(null, value); }
    setHeaderSettings(difficulty, mode) {
      if (this.kind !== 'game') throw new Error('the Global save has no difficulty or game mode');
      const m = this.mainLayout();
      if (difficulty !== null && difficulty !== undefined) { this.bytes[H.difficulty] = difficulty; this.bytes[m.settingsOffset + 6] = difficulty; }
      if (mode !== null && mode !== undefined) { this.bytes[H.gameMode] = mode; this.bytes[m.settingsOffset + 5] = mode; }
      this.seal();
      const back = this.main();
      if (difficulty != null && back.difficulty !== difficulty) throw new Error('self check: difficulty did not survive the write');
      if (mode != null && back.gameMode !== mode) throw new Error('self check: game mode did not survive the write');
      this.verifyRead('settings');
    }

    // ---- USER: player settings, game variables, money, Sommie's name ---------
    mainLayout() {
      if (this.kind !== 'game') throw new Error('the Global save has no player block');
      const sec = this.section('USER');
      const r = this.reader(sec, 'USER');
      r.want(20, 'USER section version');
      r.skip(28);
      const settingsOffset = r.pos;
      r.skip(4);                                   // user status
      r.skip(1);                                   // sequence
      const gameMode = r.byte(), difficulty = r.byte();
      r.skip(10);                                  // original difficulty, version, chapter hash, context index
      const variablesStart = r.pos;
      const blockSize = r.u32();
      if (blockSize < 40 || blockSize > r.end - variablesStart) throw new Error('the game-variable block claims ' + blockSize + ' bytes');
      const variablesEnd = variablesStart + blockSize;
      r.want(0, 'game-variable block version');
      r.skip(28);
      const countOffset = r.pos;
      const count = r.u32();
      if (count > (variablesEnd - r.pos) / 9) throw new Error('game-variable count ' + count + ' does not fit the block');
      const variables = [], materialOffsets = [-1, -1, -1];
      for (let i = 0; i < count; i++) {
        const key = r.str(8192), type = r.byte();
        const entry = { key, type, offset: r.pos };
        if (type === 0) entry.value = r.u32();
        else if (type === 1) entry.text = r.str(8192);
        else throw new Error('game variable ' + (key || i) + ' has unknown type ' + type);
        const which = key === null ? -1 : MATERIAL_KEYS.indexOf(key);
        if (which >= 0) {
          if (type !== 0 || materialOffsets[which] >= 0) throw new Error('a material variable is duplicated or holds text');
          materialOffsets[which] = entry.offset;
        }
        variables.push(entry);
      }
      if (r.pos !== variablesEnd) throw new Error('the game-variable block is ' + (variablesEnd - r.pos) + ' bytes shorter than it claims');
      const moneyOffset = r.pos;
      const money = r.i32();
      r.skip(16);                                  // progress, training count, arena count, unit-info mode
      r.str();                                     // current world-map spot
      const bondOffset = r.pos;
      const bond = r.i32();
      r.skip(4);                                   // lifetime bond fragments earned
      const nameOffset = r.pos;
      const sommieName = r.str() ?? '';
      const nameEnd = r.pos;
      const dv = this.dv();
      return {
        section: sec, settingsOffset, variablesStart, variablesEnd, countOffset, variables, materialOffsets,
        moneyOffset, bondOffset, nameOffset, nameEnd,
        values: {
          money, bondFragments: bond,
          ingots: materialOffsets.map((o) => (o < 0 ? 0 : dv.getInt32(o, true))),
          difficulty, gameMode, sommieName,
        },
      };
    }
    main() { return this.mainLayout().values; }
    setMain(patch) {
      const m = this.mainLayout(), dv = this.dv();
      if (patch.money !== undefined) dv.setInt32(m.moneyOffset, Math.trunc(patch.money), true);
      if (patch.bondFragments !== undefined) dv.setInt32(m.bondOffset, Math.trunc(patch.bondFragments), true);
      if (patch.ingots !== undefined) patch.ingots.forEach((v, i) => { if (m.materialOffsets[i] >= 0) dv.setInt32(m.materialOffsets[i], Math.trunc(v), true); });
      if (patch.difficulty !== undefined) { this.bytes[m.settingsOffset + 6] = patch.difficulty; this.bytes[H.difficulty] = patch.difficulty; }
      if (patch.gameMode !== undefined) { this.bytes[m.settingsOffset + 5] = patch.gameMode; this.bytes[H.gameMode] = patch.gameMode; }
      if (patch.sommieName !== undefined) {
        const name = String(patch.sommieName);
        if (!name.length || /[\u0000-\u001f]/.test(name)) throw new Error("Sommie's name has to be non-empty plain text");
        const body = utf16Bytes(name);
        this.splice(m.nameOffset, m.nameEnd, cat([u32bytes(body.length), body]));
      } else this.seal();
      const back = this.main();
      for (const k of ['money', 'bondFragments', 'difficulty', 'gameMode', 'sommieName'])
        if (patch[k] !== undefined && back[k] !== patch[k]) throw new Error('self check: ' + k + ' did not survive the write');
      if (patch.ingots !== undefined && back.ingots.join() !== patch.ingots.map((v) => Math.trunc(v)).join()) throw new Error('self check: the ingot counts did not survive the write');
      this.verifyRead('main');
      return back;
    }

    // Game variables, written by key - appended when the save has never used that key.
    setVariables(map) {
      const m = this.mainLayout(), dv = this.dv();
      const additions = [];
      for (const [key, value] of Object.entries(map)) {
        const hits = m.variables.filter((v) => v.key === key);
        if (hits.length > 1) throw new Error('game variable ' + key + ' appears ' + hits.length + ' times, refusing to guess');
        if (hits.length === 1) {
          if (hits[0].type !== 0) throw new Error('game variable ' + key + ' holds text, not a number');
          dv.setUint32(hits[0].offset, value >>> 0, true);
        } else additions.push(cat([encStr(key), new Uint8Array([0]), u32bytes(value >>> 0)]));
      }
      if (additions.length) {
        const records = cat(additions);
        dv.setUint32(m.variablesStart, m.variablesEnd - m.variablesStart + records.length, true);
        dv.setUint32(m.countOffset, m.variables.length + additions.length, true);
        this.splice(m.variablesEnd, m.variablesEnd, records);
      } else this.seal();
      const back = this.mainLayout();
      for (const [key, value] of Object.entries(map)) {
        const hit = back.variables.find((v) => v.key === key);
        if (!hit || hit.value !== (value >>> 0)) throw new Error('self check: variable ' + key + ' reads back as ' + (hit ? hit.value : 'missing'));
      }
      this.verifyRead('variables');
    }

    // ---- UNIT: the unit pools ------------------------------------------------
    /* Record layout, in the order the game writes it. Offsets handed out are absolute file offsets.
       u32 record length · u32 version 40 · u32 0xcdcdcdcd · 24 reserved · u64 status flags
       ref person · ref class · {u32 version 0, 11 signed personal stats} · 2 x {u32 0, 11 bytes}
       8 reserved · u8 level · u8 exp · u8 current HP · 8 reserved · optional target ref · 4 reserved
       {u32 2, u8 8} then 8 item slots · accessory list (u32 0 + 4 refs + 4) · three skill arrays
       (equipped, private, inheritable pool) · class skill · 3 u32 weapon masks
       enhancement factors x3 · hp bonus block · i8 internal level
       [AI block, only in the player/enemy/ally pools]
       customization {u8 2, u8 present, str name, u8 gender, 3 reserved}
       battle data + weapon ranks · ref emblem · ref partner emblem · ref bond ring · 4 reserved
       · optional target ref · 14 reserved · (the last 8 bytes hold i16 skill points at -8) */
    roster() {
      const sec = this.section('UNIT');
      const r = this.reader(sec, 'UNIT');
      r.want(0, 'UNIT section version'); r.want(POOL_MAGIC, 'UNIT section marker');
      r.skip(24);
      const out = []; let lastForce = -1;
      for (;;) {
        const force = r.byte();
        if (force === 255) break;
        if (force <= lastForce || force > 6) throw new Error('unit pool ' + force + ' is out of order or unknown');
        lastForce = force;
        const count = r.byte();
        if (!count || out.length + count > 250) throw new Error('unit pool ' + force + ' claims ' + count + ' units');
        for (let i = 0; i < count; i++) {
          const start = r.pos;
          const len = r.u32();
          if (len < 160 || len > r.remaining + 4) throw new Error('a unit record claims a length of ' + len + ' at ' + hexoff(start));
          const end = start + len;
          out.push(this.readUnit(new R(this.bytes, start + 4, end), out.length, force, start, end));
          r.pos = end;
        }
      }
      if (r.remaining !== 0) throw new Error('the UNIT section has ' + r.remaining + ' bytes this codec cannot account for');
      return out;
    }
    readUnit(u, index, force, start, end) {
      u.tag = 'unit ' + index;
      u.want(40, 'unit record version'); u.want(POOL_MAGIC, 'unit record marker');
      u.skip(24);
      const statusOffset = u.pos; const status = readU64(this.bytes, u.pos); u.skip(8);
      const personHash = u.ref();
      const classStart = u.pos; const classHash = u.ref(); const classEnd = u.pos;
      u.want(0, 'base capability version');
      const baseStatsOffset = u.pos;
      const personal = Array.from({ length: 11 }, () => (u.byte() << 24) >> 24);
      for (let c = 0; c < 2; c++) { u.want(0, 'growth capability version'); u.skip(11); }
      u.skip(8);
      const levelOffset = u.pos;
      const level = u.byte(), exp = u.byte(), currentHP = u.byte();
      u.skip(8);
      const hasTarget = u.byte(); if (hasTarget > 1) throw new Error('bad attack-target flag on unit ' + index);
      const attackTarget = hasTarget ? u.ref() : null;
      u.skip(4);
      u.want(2, 'unit item list version'); u.wantByte(8, 'unit item slot count');
      const items = [], itemStarts = [], itemEnds = [];
      for (let k = 0; k < 8; k++) { itemStarts[k] = u.pos; items[k] = readItem(u); itemEnds[k] = u.pos; }
      u.want(0, 'accessory list version');
      for (let k = 0; k < 4; k++) u.ref();
      u.skip(4);
      const equippedStart = u.pos, equipped = readSkills(u), equippedEnd = u.pos;
      readSkills(u);                                   // private skills: read past, not editable here
      const poolStart = u.pos, pool = readSkills(u), poolEnd = u.pos;
      const classSkillStart = u.pos;
      const csPresent = u.byte(); if (csPresent > 1) throw new Error('bad class-skill flag on unit ' + index);
      const classSkill = csPresent ? u.ref() : null;
      const classSkillEnd = u.pos;
      const masksOffset = u.pos;
      const originalProficiencies = u.u32(), proficiencies = u.u32(), selectedWeapons = u.u32();
      u.want(6, 'enhancement factors version');
      for (let k = 0; k < 3; k++) readEnhancement(u);
      u.want(1, 'enhancement calculator version');
      const hpBonus = readEnhancement(u);
      const internalLevelOffset = u.pos;
      const internalLevel = (u.byte() << 24) >> 24;
      if (force <= 2) skipAI(u);
      u.wantByte(2, 'character customization version');
      const customized = u.byte(); if (customized > 1) throw new Error('bad customization flag on unit ' + index);
      let customName = null, gender = 0, nameStart = null, nameEnd = null;
      if (customized) {
        nameStart = u.pos; customName = u.str(); nameEnd = u.pos;
        gender = u.byte(); u.skip(3);                  // language and birthday
      }
      const tailStart = u.pos;
      const t = new R(this.bytes, tailStart, end); t.tag = 'unit ' + index + ' trailer';
      t.skip(2); t.wantByte(4, 'unit battle-data version');
      const statCount = t.byte(); if (statCount > 43) throw new Error('unit battle-data count ' + statCount + ' on unit ' + index);
      t.skip(statCount * 8 + 2);
      const rankCount = t.byte(); if (rankCount > 10) throw new Error('unit weapon-rank count ' + rankCount + ' on unit ' + index);
      const weaponRanksOffset = t.pos; const weaponRanks = Array.from({ length: rankCount }, () => t.byte());
      t.skip(2);
      const linksOffset = t.pos;
      const emblemInstance = t.u32(), partnerEmblemInstance = t.u32(), ringInstance = t.u32();
      t.skip(4);
      const tTarget = t.byte(); if (tTarget > 1) throw new Error('bad unit target flag on unit ' + index);
      if (tTarget) t.ref();
      t.skip(14);
      if (t.remaining !== 0) throw new Error('unit ' + index + ' trailer has ' + t.remaining + ' bytes this codec cannot account for');
      const sp = this.dv().getInt16(end - 8, true);
      return {
        index, force, forceName: FORCES[force], start, end,
        personHash, classHash, status, statusOffset, classStart, classEnd,
        baseStatsOffset, levelOffset, internalLevelOffset, masksOffset, tailStart, linksOffset,
        personal, level, exp, currentHP, sp, internalLevel, hpBonus,
        classSkill, classSkillStart, classSkillEnd,
        equipped, equippedStart, equippedEnd, pool, poolStart, poolEnd,
        originalProficiencies, proficiencies, selectedWeapons,
        items, itemStarts, itemEnds,
        customName, gender, nameStart, nameEnd,
        emblemInstance, partnerEmblemInstance, ringInstance, weaponRanks, weaponRanksOffset,
        attackTarget,
      };
    }
    // A unit record carries its own length word, so any write that changes a record's size has to
    // update it as well (the section's size and the index are handled inside splice).
    spliceInUnit(u, start, end, replacement) {
      const recordLen = this.dv().getUint32(u.start, true);
      const delta = this.splice(start, end, replacement);
      this.dv().setUint32(u.start, recordLen + delta, true);
      this.seal();
      if (this.dv().getUint32(u.start, true) !== recordLen + delta) throw new Error('self check: the unit record length did not update');
      return delta;
    }
    // Write any of the fixed-size unit fields. The page records one undo entry per call.
    setUnit(index, patch) {
      const before = this.roster()[index];
      if (!before) throw new Error('there is no unit at index ' + index);
      const dv = this.dv();
      if (patch.level !== undefined) this.bytes[before.levelOffset] = patch.level & 0xff;
      if (patch.exp !== undefined) this.bytes[before.levelOffset + 1] = patch.exp & 0xff;
      if (patch.currentHP !== undefined) this.bytes[before.levelOffset + 2] = patch.currentHP & 0xff;
      if (patch.sp !== undefined) dv.setInt16(before.end - 8, patch.sp, true);
      if (patch.internalLevel !== undefined) this.bytes[before.internalLevelOffset] = patch.internalLevel & 0xff;
      if (patch.proficiencies !== undefined) dv.setUint32(before.masksOffset + 4, patch.proficiencies >>> 0, true);
      if (patch.selectedWeapons !== undefined) dv.setUint32(before.masksOffset + 8, patch.selectedWeapons >>> 0, true);
      if (patch.personal) for (const [k, v] of Object.entries(patch.personal)) this.bytes[before.baseStatsOffset + Number(k)] = v & 0xff;
      if (patch.weaponRanks) patch.weaponRanks.forEach((v, k) => { this.bytes[before.weaponRanksOffset + k] = v & 0xff; });
      if (patch.customName !== undefined) {
        if (before.nameStart === null) throw new Error('this unit has no saved customization block to hold a name');
        const body = utf16Bytes(String(patch.customName));
        this.spliceInUnit(before, before.nameStart, before.nameEnd, cat([u32bytes(body.length), body]));
      } else if (patch.gender !== undefined) {
        if (before.nameEnd === null) throw new Error('this unit has no saved customization block to hold a gender');
        this.bytes[before.nameEnd] = patch.gender & 0xff; this.seal();
      } else this.seal();
      const back = this.roster()[index];
      const same = (k) => patch[k] === undefined || back[k] === patch[k];
      if (!same('level') || !same('exp') || !same('currentHP') || !same('sp') || !same('internalLevel')
        || !same('proficiencies') || !same('selectedWeapons') || !same('gender')) throw new Error('self check: a unit field did not survive the write');
      if (patch.personal && Object.entries(patch.personal).some(([k, v]) => back.personal[k] !== (v << 24 >> 24))) throw new Error('self check: a personal stat did not survive the write');
      if (patch.customName !== undefined && back.customName !== String(patch.customName)) throw new Error('self check: the unit name did not survive the write');
      this.verifyRead('unit');
      return back;
    }
    // Class change. The page works out level, internal level and HP with the game's own rules (it holds
    // the class and person tables); this writes them together and relocks the class skill.
    setUnitClass(index, next) {
      const u = this.roster()[index];
      if (!u) throw new Error('there is no unit at index ' + index);
      if (u.classHash === null) throw new Error('this unit has no class reference to replace');
      const dv = this.dv();
      dv.setUint32(u.classStart, SOME_REF, true); dv.setUint32(u.classStart + 2, next.classHash >>> 0, true);
      this.bytes[u.levelOffset] = next.level & 0xff;
      this.bytes[u.levelOffset + 1] = 0;
      this.bytes[u.levelOffset + 2] = next.currentHP & 0xff;
      this.bytes[u.internalLevelOffset] = next.internalLevel & 0xff;
      dv.setUint32(u.masksOffset + 4, next.proficiencies >>> 0, true);
      dv.setUint32(u.masksOffset + 8, next.selectedWeapons >>> 0, true);
      this.seal();
      if (next.clearClassSkill !== false && u.classSkill !== null) this.spliceInUnit(u, u.classSkillStart, u.classSkillEnd, new Uint8Array([0]));
      const back = this.roster()[index];
      if (back.classHash !== (next.classHash >>> 0) || back.level !== next.level || back.internalLevel !== (next.internalLevel << 24 >> 24))
        throw new Error('self check: the class change did not survive the write');
      this.verifyRead('class');
      return back;
    }
    setUnitClassSkill(index, hashOrNull) {
      const u = this.roster()[index];
      const body = (hashOrNull === null || hashOrNull === undefined) ? new Uint8Array([0]) : cat([new Uint8Array([1]), encRef(hashOrNull)]);
      this.spliceInUnit(u, u.classSkillStart, u.classSkillEnd, body);
      const back = this.roster()[index];
      if (back.classSkill !== ((hashOrNull === null || hashOrNull === undefined) ? null : hashOrNull >>> 0)) throw new Error('self check: the class skill did not survive the write');
      this.verifyRead('class skill');
      return back;
    }
    setUnitSkills(index, which, list) {
      const u = this.roster()[index];
      if (which !== 'equipped' && which !== 'pool') throw new Error("which must be 'equipped' or 'pool'");
      this.spliceInUnit(u, which === 'equipped' ? u.equippedStart : u.poolStart, which === 'equipped' ? u.equippedEnd : u.poolEnd, encSkills(list));
      const back = this.roster()[index];
      const got = (which === 'equipped' ? back.equipped : back.pool).map((s) => s.hash).join();
      if (got !== list.map((s) => (s.hash >>> 0)).join()) throw new Error('self check: the skill list did not survive the write');
      this.verifyRead('skills');
      return back;
    }
    setUnitItem(index, slot, item) {
      const u = this.roster()[index];
      if (slot < 0 || slot > 7) throw new Error('unit item slots run 0-7');
      this.spliceInUnit(u, u.itemStarts[slot], u.itemEnds[slot], encItem(item));
      const back = this.roster()[index].items[slot];
      if (((back ? back.hash : null) >>> 0) !== ((item ? item.hash : null) >>> 0) || (back ? back.uses : null) !== (item ? item.uses : null))
        throw new Error('self check: the carried item did not survive the write');
      this.verifyRead('unit item');
      return back;
    }

    // ---- TRAN: the convoy ----------------------------------------------------
    convoy() {
      const sec = this.section('TRAN');
      const r = this.reader(sec, 'TRAN');
      r.want(1, 'TRAN section version');
      r.skip(28);
      const count = r.u16();
      if (count < 1 || count > 999 || count > r.remaining / 9) throw new Error('the convoy capacity ' + count + ' makes no sense');
      const slots = [], starts = [], ends = [];
      for (let i = 0; i < count; i++) {
        starts[i] = r.pos;
        r.want(1, 'convoy entry version');
        slots.push({ slot: i, item: readItem(r) });
        ends[i] = r.pos;
      }
      if (r.remaining !== 0) throw new Error('the convoy has ' + r.remaining + ' bytes this codec cannot account for');
      return { section: sec, count, slots, starts, ends };
    }
    setConvoySlot(slot, item) {
      const c = this.convoy();
      if (slot < 0 || slot >= c.count) throw new Error('convoy slot ' + slot + ' is outside the saved capacity');
      this.splice(c.starts[slot], c.ends[slot], cat([u32bytes(1), encItem(item)]));
      const back = this.convoy().slots[slot].item;
      if (((back ? back.hash : null) >>> 0) !== ((item ? item.hash : null) >>> 0) || (back ? back.uses : null) !== (item ? item.uses : null))
        throw new Error('self check: the convoy item did not survive the write');
      this.verifyRead('convoy');
      return back;
    }
    // Fill the uses byte of every convoy item the page says has a known maximum below its current value.
    restoreConvoyUses(maxUsesByHash) {
      const c = this.convoy();
      let changed = 0;
      for (const s of c.slots) {
        if (!s.item) continue;
        const max = maxUsesByHash[s.item.hash];
        if (max === undefined || s.item.uses === (max & 0xff)) continue;
        this.bytes[c.starts[s.slot] + 15] = max & 0xff;   // 2 version words + presence byte + 6-byte ref
        changed++;
      }
      if (!changed) return 0;
      this.seal();
      this.verifyRead('convoy uses');
      return changed;
    }

    // ---- GDBD / GOD / RING: Emblems, bonds and bond rings --------------------
    emblems() {
      const sec = this.section('GDBD');
      const r = this.poolReader(sec, 2);
      const count = r.u32();
      if (count > 500 || count > r.remaining / 11) throw new Error('Emblem bond holder count ' + count);
      const out = [];
      for (let i = 0; i < count; i++) {
        const instance = r.u32();
        const id = r.str(8192);
        if (!instance || !id) throw new Error('Emblem bond holder ' + i + ' has no instance id or no Emblem id');
        const special = r.byte();
        if (special > 1) throw new Error('unknown Pact Ring record on ' + id);
        if (special === 1) r.want(0, 'Pact Ring record');
        const pactPartner = special === 1 ? r.str(8192) : null;
        const bonds = [];
        const bondCount = r.u16();
        if (bondCount > 250 || bondCount > r.remaining / 20) throw new Error('bond count ' + bondCount + ' on ' + id);
        for (let k = 0; k < bondCount; k++) {
          const pid = r.str(8192);
          if (!pid) throw new Error('a bond on ' + id + ' has no character id');
          r.want(3, 'Emblem bond version');
          const offset = r.pos;
          const level = r.byte(), experience = r.u16();
          r.want(2, 'Emblem inherited-skill version');
          const n = r.u32();
          if (n > 1280 || n > (r.remaining - 1) / 4) throw new Error('Emblem inherited-skill count ' + n);
          const skills = Array.from({ length: n }, () => r.u32());
          const flagsOffset = r.pos;
          const flags = r.byte();
          bonds.push({ personId: pid, personHash: fnv1a(pid), level, experience, skills, flags, offset, flagsOffset });
        }
        out.push({ instance, id, hash: fnv1a(id), pactPartner, bonds });
      }
      if (r.remaining !== 0) throw new Error('the GDBD section has ' + r.remaining + ' bytes this codec cannot account for');
      return out;
    }
    setBondLevel(instance, personId, level, experience, talkFlags) {
      const god = this.emblems().find((g) => g.instance === instance);
      if (!god) throw new Error('there is no Emblem instance ' + instance);
      const bond = god.bonds.find((b) => b.personId === personId);
      if (!bond) throw new Error(personId + ' has no saved bond with that Emblem');
      this.bytes[bond.offset] = level & 0xff;
      this.bytes.set(u16bytes(experience & 0xffff), bond.offset + 1);
      if (talkFlags !== undefined) this.bytes[bond.flagsOffset] = (this.bytes[bond.flagsOffset] & ~14) | (talkFlags & 14);
      this.seal();
      const back = this.emblems().find((g) => g.instance === instance).bonds.find((b) => b.personId === personId);
      if (back.level !== (level & 0xff) || back.experience !== (experience & 0xffff)) throw new Error('self check: the bond level did not survive the write');
      this.verifyRead('bond');
      return back;
    }
    ownedGods() {
      const sec = this.section('GOD');
      const r = this.poolReader(sec, 8);
      const count = r.u32();
      if (count > 500) throw new Error('owned Emblem count ' + count);
      const out = [];
      for (let i = 0; i < count; i++) {
        const start = r.pos;
        const instance = r.u32();
        if (!instance) throw new Error('owned Emblem ' + i + ' has no instance id');
        const hash = r.ref();
        if (hash === null) throw new Error('owned Emblem ' + i + ' has no Emblem reference');
        const holder = r.u32();
        const darkness = r.byte(), reserved = r.byte(), escaping = r.byte();
        if (darkness > 1 || reserved > 1 || escaping > 1) throw new Error('unknown owned Emblem flags on instance ' + instance);
        const dirtinessOffset = r.pos;
        const dirtiness = r.byte();
        const synchro = r.byte();
        for (let k = 0; k < synchro; k++) { r.str(8192); r.skip(2); }
        const weapons = r.byte();
        for (let k = 0; k < weapons; k++) { r.str(8192); r.skip(10); r.str(8192); }
        out.push({ instance, hash, holder, darkness: !!darkness, reserved: !!reserved, escaping: !!escaping, dirtiness, dirtinessOffset, start, end: r.pos });
      }
      if (r.remaining !== 0) throw new Error('the GOD section has ' + r.remaining + ' bytes this codec cannot account for');
      return out;
    }
    setGodDirtiness(instance, value) {
      const before = this.ownedGods().find((g) => g.instance === instance);
      if (!before) throw new Error('there is no owned Emblem instance ' + instance);
      this.bytes[before.dirtinessOffset] = value & 0xff;
      this.seal();
      if (this.ownedGods().find((g) => g.instance === instance).dirtiness !== (value & 0xff)) throw new Error('self check: dirtiness did not survive the write');
      this.verifyRead('dirtiness');
    }
    rings() {
      const sec = this.section('RING');
      const r = this.poolReader(sec, 3);
      const count = r.u32();
      if (count > 750 || r.remaining % 11) throw new Error('the bond ring pool size makes no sense (' + count + ' entries in ' + r.remaining + ' bytes)');
      const owners = {};
      for (const u of this.roster()) if (u.ringInstance) owners[u.ringInstance] = u.index;
      const out = [];
      for (let i = 0; i < count; i++) {
        const instance = r.u32();
        const hash = r.ref();
        if (!instance || hash === null) throw new Error('bond ring ' + i + ' has no instance id or no ring reference');
        const stockOffset = r.pos;
        const stock = r.byte();
        out.push({ instance, hash, stock, stockOffset, ownerIndex: owners[instance] === undefined ? null : owners[instance] });
      }
      return out;
    }
    setRingStock(instance, stock) {
      const before = this.rings().find((x) => x.instance === instance);
      if (!before) throw new Error('there is no bond ring instance ' + instance);
      this.bytes[before.stockOffset] = stock & 0xff;
      this.seal();
      if (this.rings().find((x) => x.instance === instance).stock !== (stock & 0xff)) throw new Error('self check: ring stock did not survive the write');
      this.verifyRead('ring stock');
    }

    // ---- UREL: character supports -------------------------------------------
    supports() {
      const sec = this.section('UREL');
      const r = this.poolReader(sec, 1);
      const count = r.u32();
      if (count > 10000 || count > r.remaining / 11) throw new Error('support record count ' + count);
      const out = [];
      for (let i = 0; i < count; i++) {
        const key = r.str(8192);
        if (!key) throw new Error('support record ' + i + ' has no pair key');
        r.want(1, 'support record version');
        const offset = r.pos;
        const rank = r.byte();
        if (rank > 4) throw new Error('support rank ' + rank + ' on ' + key + ' is not one the game writes');
        const points = (r.byte() << 24) >> 24, score = (r.byte() << 24) >> 24;
        out.push({ key, rank, points, score, offset });
      }
      if (r.remaining !== 0) throw new Error('the UREL section has ' + r.remaining + ' bytes this codec cannot account for');
      return out;
    }
    setSupport(key, rank, points, score) {
      const before = this.supports().find((s) => s.key === key);
      if (!before) throw new Error('this save has no support record for that pair');
      if (rank > 4) throw new Error('support rank must be 0-4');
      this.bytes.set([rank & 0xff, points & 0xff, (score === undefined ? before.score : score) & 0xff], before.offset);
      this.seal();
      const back = this.supports().find((s) => s.key === key);
      if (back.rank !== (rank & 0xff) || back.points !== ((points << 24) >> 24)) throw new Error('self check: the support did not survive the write');
      this.verifyRead('support');
      return back;
    }

    // ---- carrying an Emblem or a bond ring ----------------------------------
    // Both live as three u32s at the end of a unit record (Emblem instance, Engage+ partner, bond ring),
    // and a bond ring also has to exist as a 11-byte entry in the RING pool, so equipping is a two-section
    // edit. The pool is rewritten first: RING sits before UNIT in the file, soresizing it moves every
    // unit offset. Equipping never creates or destroys copies - a stack of 5 becomes 4 in the stack and
    // 1 in the unit's hands.
    writeRingPool(rings) {
      const sec = this.section('RING');
      if (rings.length > RING_POOL.max || rings.length > RING_POOL.maxUnequipped + RING_POOL.maxEquipped)
        throw new Error('the bond ring pool cannot hold ' + rings.length + ' entries');
      const header = this.bytes.slice(sec.payload, sec.payload + 32);        // version, marker, reserved
      const body = [];
      const seen = new Set();
      for (const r of rings) {
        if (!r.instance || r.instance > RING_POOL.max || seen.has(r.instance)) throw new Error('bond ring instance ' + r.instance + ' is unusable');
        if (r.stock < 0 || r.stock > RING_POOL.stockMax) throw new Error('ring stock ' + r.stock + ' is outside 0-' + RING_POOL.stockMax);
        if (r.owner !== null && r.owner !== undefined && r.stock !== 1) throw new Error('an equipped ring is always exactly 1 copy');
        seen.add(r.instance);
        body.push(cat([u32bytes(r.instance), encRef(r.hash), new Uint8Array([r.stock & 0xff])]));
      }
      const equipped = rings.filter((r) => r.owner !== null && r.owner !== undefined).length;
      if (equipped > RING_POOL.maxEquipped) throw new Error('only ' + RING_POOL.maxEquipped + ' rings can be carried at once');
      this.splice(sec.payload, sec.payload + sec.len, cat([header, u32bytes(rings.length), cat(body)]));
    }
    // sel = { kind: 'none' | 'emblem' | 'ring', instance }
    setUnitEquipment(index, sel) {
      const kind = sel && sel.kind ? sel.kind : 'none';
      if (['none', 'emblem', 'ring'].indexOf(kind) < 0) throw new Error("kind must be 'none', 'emblem' or 'ring'");
      const unit = this.roster()[index];
      if (!unit) throw new Error('there is no unit at index ' + index);
      if (unit.partnerEmblemInstance) throw new Error('this unit is in an Engage+ link - end it in the game before changing what it carries');
      const owned = this.ownedGods();
      const current = unit.emblemInstance ? { kind: 'emblem', instance: unit.emblemInstance }
        : unit.ringInstance ? { kind: 'ring', instance: unit.ringInstance } : { kind: 'none', instance: 0 };
      if (kind === current.kind && (sel.instance || 0) === current.instance) { this.seal(); return current; }
      if (kind !== 'none') {
        if (!sel.instance) throw new Error('pick an Emblem or a bond ring first');
        if (kind === 'emblem' && !owned.some((g) => g.instance === sel.instance)) throw new Error('you do not own that Emblem instance');
        if (kind === 'ring' && !this.rings().some((r) => r.instance === sel.instance)) throw new Error('that bond ring is not in the pool');
      }

      const pool = this.rings().map((r) => ({ instance: r.instance, hash: r.hash, stock: r.stock, owner: r.ownerIndex }));
      const byInstance = (i) => pool.find((r) => r.instance === i);
      const returnToPool = (instance) => {
        const ring = byInstance(instance);
        if (!ring) return;
        ring.owner = null;
        const stack = pool.find((r) => r.hash === ring.hash && r.instance !== ring.instance && (r.owner === null || r.owner === undefined));
        if (stack) { stack.stock += ring.stock; pool.splice(pool.indexOf(ring), 1); }
      };
      // undo what this unit (or any other) currently carries, in the pool as well as on the record
      if (current.kind === 'ring') returnToPool(current.instance);
      let carryRing = 0, carryEmblem = 0, allocated = 0;
      const clears = [];
      if (kind === 'ring') {
        const ring = byInstance(sel.instance);
        const otherOwner = ring.owner === null || ring.owner === undefined ? null : ring.owner;
        if (otherOwner !== null && otherOwner !== index) { pool.find((r) => r.instance === sel.instance).owner = null; clears.push(otherOwner); }
        if (ring.stock === 1) {
          pool.find((r) => r.instance === sel.instance).owner = index;
          carryRing = sel.instance; allocated = sel.instance;
        } else {
          pool.find((r) => r.instance === sel.instance).stock = ring.stock - 1;
          const used = new Set(pool.map((r) => r.instance));
          let fresh = 0;
          for (let i = 1; i <= RING_POOL.max; i++) if (!used.has(i)) { fresh = i; break; }
          if (!fresh) throw new Error('the bond ring pool has no free slot for a carried copy');
          pool.push({ instance: fresh, hash: ring.hash, stock: 1, owner: index });
          carryRing = fresh; allocated = fresh;
        }
      } else if (kind === 'emblem') {
        carryEmblem = sel.instance;
        const previous = this.roster().find((x) => x.emblemInstance === sel.instance && x.index !== index);
        if (previous) clears.push(previous.index);        // one Emblem, one bearer: the old one lets go
      }

      this.writeRingPool(pool);                       // may move every unit offset, so re-read after
      const setCarry = (unitIndex, emblem, ring) => {
        const u = this.roster()[unitIndex];
        const dv = this.dv();
        dv.setUint32(u.linksOffset, emblem >>> 0, true);
        dv.setUint32(u.linksOffset + 8, ring >>> 0, true);
        this.bytes[u.tailStart] = 0; this.bytes[u.tailStart + 1] = 0;               // engaged turns, this battle
        const flags = dv.getBigUint64(u.statusOffset, true) & ~0x07800080n;           // carrying / engaged state
        dv.setBigUint64(u.statusOffset, flags, true);
      };
      for (const unitIndex of clears) { const u = this.roster()[unitIndex]; setCarry(unitIndex, 0, 0); }
      setCarry(index, carryEmblem, carryRing);
      this.seal();

      const after = this.roster()[index];
      const wantEmblem = kind === 'emblem' ? sel.instance : 0, wantRing = kind === 'ring' ? allocated : 0;
      if (after.emblemInstance !== wantEmblem || after.ringInstance !== wantRing)
        throw new Error('self check: the unit is still carrying ' + (after.emblemInstance ? 'Emblem ' + after.emblemInstance : after.ringInstance ? 'ring ' + after.ringInstance : 'nothing'));
      const totalsBefore = {}, totalsAfter = {};
      for (const r of pool) totalsBefore[r.hash] = (totalsBefore[r.hash] || 0) + (r.owner === null || r.owner === undefined ? r.stock : 1);
      for (const r of this.rings()) totalsAfter[r.hash] = (totalsAfter[r.hash] || 0) + r.stock;
      for (const h of Object.keys(totalsAfter)) if ((totalsBefore[h] || 0) !== totalsAfter[h])
        throw new Error('self check: the edit changed how many copies of ring ' + hex(h, 8) + ' the save holds');
      this.verifyRead('equipment');
      return { kind, instance: allocated || carryEmblem };
    }

    // Put a whole previous version of this save back (used by the page's undo for edits that touch
    // several units at once, like moving an Emblem). Re-parses and verifies like any other load.
    loadBytes(bytes) {
      const probe = new Save(bytes.slice(), this.name, this.hdrCrcOffset);
      this.bytes = bytes.slice();
      this.parse();
      if (!this.crcOk || !this.hdrCrcOk) throw new Error('self check: the restored bytes do not carry matching checksums');
      void probe;
      return this;
    }

    // ---- raw bytes -----------------------------------------------------------
    getBytes(at, n) { return this.bytes.subarray(at, Math.min(at + n, this.bytes.length)); }
    setBytes(at, hex) {
      const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
      if (!clean.length || clean.length % 2) throw new Error('type an even number of hex digits');
      const body = new Uint8Array(clean.length / 2);
      for (let i = 0; i < body.length; i++) body[i] = parseInt(clean.substr(i * 2, 2), 16);
      if (at >= H.index && at < H.index + INDEX_SIZE) throw new Error('refusing to write the section index by hand');
      if (this.bytes.length - at <= 8) throw new Error('refusing to write over the checksum footer');
      const sec = this.sectionAt(at);
      if (sec && at + body.length > sec.payload + sec.len) throw new Error('a raw write has to stay inside one section (that one ends at ' + hexoff(sec.payload + sec.len) + ')');
      const old = this.bytes.slice(at, at + body.length);
      this.bytes.set(body, at);
      this.seal();
      if (this.bytes.slice(at, at + body.length).join() !== body.join()) throw new Error('self check: the raw write did not land');
      this.verifyRead('raw');
      return old;
    }
    poolReader(section, version) {
      const r = this.reader(section, section.name);
      r.want(version, section.name + ' pool version');
      r.want(POOL_MAGIC, section.name + ' pool marker');
      r.skip(24);
      return r;
    }
  }

  function readU64(bytes, at) { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(bytes[at + i]) << BigInt(8 * i); return v; }
  function readSkills(r) {
    r.want(1, 'skill array version');
    const count = r.u32();
    if (count > 1280 || count > r.remaining / 10) throw new Error('skill array length ' + count);
    const out = [];
    for (let i = 0; i < count; i++) {
      const hash = r.ref();
      if (hash === null) throw new Error('a skill entry has no skill reference');
      out.push({ hash, age: r.u32(), category: r.u32() });
    }
    return out;
  }
  function encSkills(list) {
    const parts = [u32bytes(1), u32bytes(list.length)];
    for (const s of list) parts.push(encRef(s.hash), u32bytes(s.age >>> 0), u32bytes(s.category >>> 0));
    return cat(parts);
  }
  function readEnhancement(r) {
    r.want(1, 'enhancement capability version'); r.want(11, 'enhancement capability count');
    const hp = r.u32(); r.skip(40); return hp;
  }
  function skipAI(r) {
    r.want(7, 'character AI version');
    r.skip(4 + 13);
    r.str();
    r.want(0, 'AI movement range version');
    r.skip(5 + 2);
    for (let i = 0; i < 4; i++) r.str();
    for (let i = 0; i < 16; i++) { r.want(0, 'AI value version'); r.skip(2); }
  }

  // Every edit is atomic: if a write does not read back exactly as asked, or the file stops parsing,
  // the save goes back to the bytes it had before the call and the page reports the reason.
  const WRITERS = ['setPlaytime', 'setDifficulty', 'setGameMode', 'setHeaderSettings', 'setMain', 'setVariables',
    'setUnit', 'setUnitClass', 'setUnitClassSkill', 'setUnitSkills', 'setUnitItem', 'setConvoySlot',
    'restoreConvoyUses', 'setBondLevel', 'setGodDirtiness', 'setRingStock', 'setSupport', 'setBytes', 'setUnitEquipment'];  for (const name of WRITERS) {
    const inner = Save.prototype[name];
    Save.prototype[name] = function (...args) {
      const bytes = this.bytes.slice(), hdr = this.hdrCrcOffset;
      try { return inner.apply(this, args); }
      catch (e) { this.bytes = bytes; this.hdrCrcOffset = hdr; this.parse(); throw e; }
    };
  }

  // ============================ recognising files ============================
  function looksLikeSave(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 200) return false;
    if (tagAt(b, b.length - 8) !== 'LVRC') return false;
    return tagAt(b, 0) === 'EDNI' || (b.length >= 0x80 + INDEX_SIZE + 8 && tagAt(b, 0x80) === 'EDNI');
  }
  const looksLikeGlobal = (bytes) => looksLikeSave(bytes) && tagAt(bytes, 0) === 'EDNI';

  // ---- refusing the other game ---------------------------------------------
  /* Both titles travel in the same .dmsync container, so a Three Houses container opens happily here and the
     saves inside are the only thing that says which game they belong to. Three Houses has no magic word - its
     12-byte header is u32 byte-sum of the body, u32 save version (12, 13 or 23), u32 file size - so size-equals
     -length plus the version list names it, and no Engage header can satisfy that (it keeps a chapter hash at
     0x08 and the game version at 0x04, and carries the LVRC footer this reader insists on anyway).
     Silently skipping such a file reads as "opened fine, 0 saves", which looks like a bug in this page. */
  const OTHER_GAME = 'Fire Emblem Three Houses';
  function looksLikeOtherGame(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!b || b.length < 0x20000) return false;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return v.getUint32(8, true) === b.length && [12, 13, 23].includes(v.getUint32(4, true));
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
    ? OTHER_GAME + ' save - this page edits Engage, so it was skipped'
    : 'not an Engage save file, skipped';

  // Chapter ids are not in the data dumps, but they are short and enumerable, so hash the plausible
  // shapes and match them against the save's two chapter hashes. This gives "CID_M007" back, which is
  // a chapter's real id; the friendlier "Chapter 7" label would need the game's message table.
  let chapterCache = null;
  function chapterNames() {
    if (chapterCache) return chapterCache;
    const out = new Map();
    const add = (id) => out.set(fnv1a(id), id);
    for (const prefix of ['M', 'S', 'T', 'X', 'D', 'G', 'R', 'B', 'E', 'H', 'K', 'N', 'P', 'Q', 'V', 'W', 'Z', 'A', 'C', 'F', 'J', 'L', 'O', 'U', 'Y'])
      for (let n = 0; n < 200; n++) {
        const num = String(n).padStart(3, '0');
        add('CID_' + prefix + num); add('CID_' + prefix + num + '_00'); add('CID_' + prefix + num + '_PLACE');
      }
    for (const id of ['CID_OPENING', 'CID_END', 'CID_TITLE', 'CID_PROLOGUE', 'CID_EPILOGUE', 'CID_TEST', 'CID_START']) add(id);
    return (chapterCache = out);
  }
  const chapterName = (hash) => chapterNames().get(hash >>> 0) || null;

  const fmtTime = (s) => Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm ' + String(Math.floor(s % 60)).padStart(2, '0') + 's';

  const api = {
    DMS, Save, looksLikeSave, looksLikeGlobal, fnv1a, crc32, chapterName, fmtTime,
    H, STAT_NAMES, WEAPON_TYPES, FORCES, DIFFICULTY, GAME_MODE, SUPPORT_RANK, MATERIAL_KEYS, QTY_PREFIX,
    OTHER_GAME, looksLikeOtherGame, containerHoldsOtherGame, wrongGameNote,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FEE = api;
})(typeof window !== 'undefined' ? window : globalThis);
