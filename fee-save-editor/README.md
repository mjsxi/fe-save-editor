# Fire Emblem Engage save editor

A single web page that edits Fire Emblem Engage save files in place — `Auto`, `Manual0`, `Global` — and nxnative
cloud saves (`save.dmsync`) too. No server, no install, no upload — open `index.html` and the page reads and writes
the bytes itself.
It is the Engage twin of [`../fe3h-save-editor`](../fe3h-save-editor/README.md); same look, same "open it twice a week and it is still there" design.

Open it by double-clicking **`index.html`** (tested in Safari; the SHA-256 the container needs works from `file://`).

```
index.html              the whole app: UI + save format + container format
js/fee.js               save file and .dmsync codec (also loadable in node, for the tests)
js/data-en.js           item / character / class / skill / Emblem / ring / support names, generated
tools/build-data.mjs    regenerates js/data-<lang>.js from tools/sources/ - same two-step shape as the
                        Three Houses editor, except Engage's dumps are already JSON so there is no
                        dump-sources.mjs step here
tools/test-codec.mjs    149 checks of the codec against a real save, including that it refuses a Three Houses
                        save; exits non-zero on failure
tools/test-page.mjs     54 checks of the page itself (jsdom): choose-files and drag-drop both open a
                        save, every tab renders, widgets write, revert works, the repack reads back
tools/sources/          JSON tables: items, roster, emblems, bracelets, rings, engravings, supports,
                        quantity items, ring melding, roster-creation
```

## Use

1. **Open a save.** Use **choose files**, or drag the save files onto the page: `Auto`, `Manual0`, `Manual1`, …
   and `Global` if you have it — whatever you have, from wherever you keep them (a save-manager export, the game's
   save-data folder under `0100A6301214E000`, an emulator's user directory). Pick the files rather than the folder
   around them; you can select several at once, and the page reads each one it recognises.
   *Cloud saves:* if your save came out of nxnative, drop **`save.dmsync`** instead — it is the same `save/` folder
   packed into one file (mine sits at `../fee-save/0100A6301214E000/save.dmsync`). The page unpacks and verifies
   it, and everything below is identical; dropping a loose file too replaces the copy inside the container.
2. **Pick a slot.** Each button shows the chapter id and playtime. The pills under it show Alear's name, money,
   bond fragments, chapter, difficulty and mode, how many player units there are, how full the convoy is, how many
   Emblems you own, and whether both stored checksums are currently valid.
3. **Edit.** Tabs: **Overview** (Alear's name and gender, money, bond fragments, ingots, play time, difficulty,
   game mode, Sommie's name, and a read-only map of the save: chapter ids, sequence, every section and its size),
   **Units** (level, exp, SP, internal level, current HP, the 11 personal stats with their caps shown, class change
   with the game's own level/HP rules, class skill, inheritable skills with the one-per-family rule, two equipped
   inheritance slots, 8 carried items, and what Emblem or bond ring they carry - offering only Emblems you own that
   the character has a bond with, and splitting a copy out of a ring stack), **Convoy and storage** (999 convoy slots with uses, refine and
   Emblem engravings, plus the 105 counted items the game keeps as variables: seals, ingots' neighbours,
   ingredients, gifts, key items), **Emblems and rings** (bond level per character per Emblem with the real
   thresholds and a max button, dirtiness, which unit carries what, ring stock against the shared 99 limit),
   **Supports** (rank, points and score per pair, quick C/B/A buttons using that pair's own thresholds, Pact
   protection), **Raw bytes** (hex view and write, with jumps to each section).
   Every change appears in **3 · Changes** with a **revert** button, newest first.
4. **Download.** You get back what you opened: the save file under its own name (`Auto`, `Manual0`, …) with its
   header checksum and whole-file CRC32 recomputed — **Download this save file** — or, if you opened a container,
   **Download save.dmsync**, which re-packs it. Either way the page reads its own output back with the same reader
   it uses on other people's files, and refuses to hand you a file that does not read back clean.
5. **Put it back** where it came from, with the game closed, and **keep your original copy**. Replacing a cloud
   save: quit the game on the phone *and* in the Mac app first, then drop the downloaded
   `0100A6301214E000-save.dmsync` over `../fee-save/0100A6301214E000/save.dmsync`.

## What is safe and what is not

Nothing here checks values the game would check beyond what is listed per field. An impossible class, skill, ring or
item id can crash a battle or a menu. **The container and both checksums are always recomputed correctly, and every
write is rolled back if the file stops parsing after it** — so a mistake costs you a save slot, not the file.
**Keep the copy you opened**: the page never writes to disk, everything is in memory until you download.

One thing it does check: the save belongs to this game. A Three Houses save — loose, or the contents of a Three
Houses `save.dmsync` — is refused by name rather than failing as "no section index", and a Three Houses container
is refused from what is inside it rather than opening as a container with no saves in it.

Two things the equipment edits deliberately do, because the alternative is a save that lies about its own state:
changing what a unit carries clears that unit's *engaged this battle* counter and its carry flags (the game
re-derives them in battle), and a unit in an **Engage+ link** is refused outright rather than half-changed. Alear's
own Emblem cannot be given to anyone else. Nothing here has been checked in-game — a ring swap you can undo from a
backup is the sensible first experiment.

Bytes the page does not understand are copied through untouched: `REST` (story and event flags), `MAP`, `PROF`
(achievements), `PROL`, the enemy AI block inside each unit record, the private-skill array, and everything after the
last field it reads in a unit record. The `Global` save is opened and described but never written.

## How the format was worked out

Save file: 128-byte header, section index, sections, `LVRC`, CRC32 of everything before it.

| offset | what |
| --- | --- |
| `0x00` | u32 format version (9 from game 1.0 through 2.0), u32 game version (304 = 2.0.0) |
| `0x0C` | u8 marker 2 + u32 hash of the current chapter id, `0x11` same for the next chapter |
| `0x16` | u16 sequence, `0x17` difficulty, `0x19` game mode, `0x1A` u32 counter |
| `0x28` | f32 play time in seconds (mirrored at `TIME` payload + 32) |
| `0x42` | u32 CRC32 of the header bytes before it |
| `0x80` | `EDNI` + 32 u32 section offsets (`Global` saves keep the index at `0x00`) |
| each section | 4-character tag stored reversed (`USER` is written `RESU`) + u32 size + payload |

Section map of a game save, with what the page does with each:

| section | holds | page |
| --- | --- | --- |
| `USER` | player settings, money, bond fragments, Sommie's name, ~180 game variables | reads and writes |
| `GDBD` | Emblem bond holders: per Emblem, per character level + exp + inherited skills | reads and writes |
| `GOD` | owned Emblem instances, dirtiness, story-reserved and Engage+ flags | dirtiness, and (with `UNIT`) what each unit carries |
| `RING` | bond ring pool: instance, ring, stock | stock, and carrying a copy in or out (11-byte entries, rewritten as a pool) |
| `UNIT` | unit pools (player / enemy / ally / absent / dead / lost / temporary) | reads and writes |
| `TRAN` | the convoy, 999 slots | reads and writes |
| `UREL` | per-pair support rank, points, score | reads and writes |
| `TIME` `PROF` `PROL` `REST` `MAP` | play time, achievements, story flags, map data | read only |

**DLC Bracelets** are the one wrinkle: the owned-Emblem record (`GOD`) is keyed to one hero's id and the bond
record (`GDBD`) to another, so a Bracelet's own hash is not in the Emblem table. Your save proves it - instance 5
is `GID_ディミトリ` on the `GOD` side and `GID_エーデルガルト` on the bond side - so `tools/sources/bracelets.json`
maps both sides to the label the game uses ("Bracelet of the Three Houses"), and the page names it from either.

References to game data are `u16 0xccdb` (none) or `u16 0xefcd` + a **u32 FNV-1a hash of the UTF-16 code units of the
game's own Japanese id**: `IID_はがねのつるぎ` → Steel Sword, `PID_リュール` → Alear, `JID_…` classes, `SID_…` skills,
`GID_…` Emblems, `RNID_紋章_シーダ_C` → Caeda's C ring, `CID_M007` chapters. That is why `js/data-en.js` exists: the
save only carries numbers, the names come from the game's tables in `tools/sources/`. Strings are `u32` byte length
(`0xffffffff` = none) + UTF-16LE.

Checked against the save in `../fee-save/` by `tools/test-codec.mjs` (149 checks), not just against documentation:

- the stored CRC32 equals the CRC32 of the file, for `Auto`, `Manual0` and `Global`, and the header's own checksum
  lands in exactly one place (`0x42`);
- re-packing the opened container reproduces it **byte for byte**;
- the 999 convoy slots all decode, every item hash resolves to a named item, and no refine level exceeds the item's own maximum;
- the unit pools walk to the end of `UNIT` with zero bytes left over: 8 player units (Alear, Chloé, Framme, Alfred,
  Etie, Céline, Jean, Yunaka), 34 enemies, 5 absent — and every personal stat sits under its class limit plus that
  character's modifier;
- the next-chapter hash in the header equals `fnv1a("CID_M007")`, which is what confirmed the hash function;
- all 231 support records, every Emblem bond, and every ring resolve by name; the 6 ranked pairs match their own thresholds;
- **every write the page can do** — money, play time, difficulty, ingots, Sommie's name, a new game variable,
  convoy add/clear/refine, unit level/exp/SP/stats, class change, skill inherit and forget, class skill, carried
  item, bond level, ring stock, dirtiness, support rank, equipping and unequipping an Emblem or a bond ring, raw
  bytes — writes, reads back the same value, and restores the file byte for byte when undone;
- carrying a ring out of a stack of 3 leaves 2 in the stack plus a new entry of 1, the totals per ring never change,
  the pool grows by exactly 11 bytes, the section index follows so `UNIT` starts 11 bytes later, and the edited file
  still parses every section end to end;
- and the refusals: writing the footer or the section index, a raw write that crosses out of its section, an
  out-of-range play time, a convoy slot past 999, an Emblem this save does not own, a bond ring that is not in the
  pool, a truncated file, and a Three Houses save — named as such, both loose and inside a container.
- the page itself, in a real DOM: choose-files and drag-drop both open a save and the picker opens exactly once per
  click, all six tabs render, edits applied through the widgets land, one revert puts things back, and the repacked
  download reads back with a matching hash (`tools/test-page.mjs`, 54 checks).

## Development

```sh
node tools/test-codec.mjs      # 149 checks against your real save; exits non-zero on failure
node tools/test-page.mjs       # 54 checks against the page (needs `npm install jsdom` once)
node tools/build-data.mjs      # regenerate js/data-<lang>.js after changing tools/sources
```

Both suites are opt-in and quick: about a third of a second for the codec, two and a half for the page.
`test-codec.mjs` takes a path if your save lives elsewhere: `node tools/test-codec.mjs path/to/save.dmsync`.
Both suites want a packed `save.dmsync`, since they check the container as well as the save — the page itself works
with loose `Auto` / `Manual0` files, the tests are the part that wants the container.
Add a language by dropping its name columns into `tools/sources/` and running `LANGS=ja node tools/build-data.mjs`,
then add a `<script src>` line in `index.html`. The name and limit tables in `tools/sources/` come from the
game's own data dumps (the ones `hashcade/fee-save-editor` builds on); the save-format reading here was written
from the Engage container and record layouts and checked against this save.

## Added since the first version

- **Equip and unequip Emblems and bond rings** (Units tab, "Emblem or bond ring"): only Emblems this save owns that
  the character has a bond with are offered, and Alear's own Emblem stays hers. An Emblem moves rather than
  duplicating; taking a ring from a stack of several shortens the stack and makes a new single-copy entry, and
  returning it folds it back. One undoable change per move, and units in an Engage+ link are left alone.
- **DLC Bracelet names**, from the record quirk described above: Etie's Emblem now reads
  "Bracelet of the Three Houses" instead of a bare hash.
- **The choose-files fix**, plus a test that the picker opens exactly once per click and that the same file can be
  picked twice in a row.

## What is next (v2)

Everything below is already understood — the codec reads these sections today — it just has no UI yet. In the order
I'd do them:

1. **Add and remove Emblems**, with the bond-holder record, the `G_指輪_*` / level-cap game variables it sets, and
   unequipping first. Bond-ring **melding** (2 C → B, 3 B → A, 4 A → S, with bond-fragment costs) too.
2. **Bring back dead or lost characters** (the `Dead` / `Lost` pools and the status bit the game uses) and
   **recruit missing ones**, which needs `tools/sources/roster-creation.json` (already vendored).
3. **Achievements** (`PROF`, 765 of them, with claim state) and the **game-variable browser** for everything that is
   not a counted item.
4. **Somniel life**: donations per country, strength-training and arena uses, push-up/sit-up/squat/wyvern/fishing
   records, animals, amiibo outfits and music.
5. **Relay tickets** in the `Global` save (it is read but never written today), and a **chapter picker** — the two
   chapter hashes resolve to ids like `CID_M007`, but the friendly "Chapter 7" label needs the game's message table.
6. **Names**: a second language, and printing the skill list per family with tiers instead of a flat filter.
7. **Undo across reloads**: keep the change list in the file so a reload does not lose it.

Not planned: anything that edits the game files rather than the save.
