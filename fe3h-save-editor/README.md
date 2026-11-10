# Fire Emblem Three Houses save editor

A single web page that edits FE3H saves in place, including nxnative cloud saves (`save.dmsync`).
No server, no install, no upload — open `index.html` and the page reads and writes the bytes itself.
It is the Three Houses half of a pair: `../../fire emblem engage/fee-save-editor` is the same design for Engage,
down to the two-step `tools/sources/*.json -> js/data-<lang>.js` build and the same two kinds of test.

Open it by double-clicking **`index.html`** (works from `file://`; checked in Safari, and the tests below run the
page itself in a headless DOM, so the open-a-file path and every tab are covered without a browser).

```
index.html              the whole app: UI + save format + container format
js/fe3h.js              save file and .dmsync codec (also loadable in node, for the tests)
js/data-en.js           item / unit / class / skill / spell names, generated from the game's own tables
tools/build-data.mjs    tools/sources/*.json  ->  js/data-<lang>.js
tools/test-codec.mjs    71 checks of the codec against a real save
tools/test-picker.mjs   10 checks that "choose files" opens the picker once and loads the file
tools/sources/          items.json, roster.json, supports.json, glossary.json - read by build-data.mjs,
                        and the authority: extracted once from the game's own tables (see the
                        extraction map below), the dumps themselves are not kept
```

## Use

1. **Open a save.** Drag `save.dmsync` onto the page — for this game that is
   `../fe3h-save/010055D009F78000/save.dmsync`. Loose save files (`auto`, `slot00`, …) work too, as does a
   mix of both; a loose file you dropped replaces the copy inside the container.
2. **Pick a slot.** Each button shows chapter and playtime. The pills under it show name, gold, chapter,
   difficulty, how many units are in slots, and whether the stored checksum is currently valid.
3. **Edit.** Tabs: Overview (gold, chapter, playtime, difficulty, style, map), Units (every unit slot:
   stats, level, class, class mastery, weapon/magic ranks, combat arts, spells, 240 ability flags, carried
   items, battalion, deployment, flags), Item box (the 400-slot inventory), Barracks,
   Supports (each conversation labelled with its pair, its points and its rank, with C/B/A/S quick-set
   buttons), Activity (reputation, instruct exp, activity uses, statue levels), Raw bytes (write any offset).
   Every change appears in **3 · Changes** with a **revert** button, newest first.
4. **Download save.dmsync.** The page re-computes the save's checksum, re-packs the container, then reads
   its own output back with the same reader it uses on other people's files, and refuses to hand you a file
   that does not read back clean.
5. **Put it back.** Quit the game on the phone *and* in the Mac app first, then drop the downloaded
   `010055D009F78000-save.dmsync` over `../fe3h-save/010055D009F78000/save.dmsync`. Keep your original copy.

## What is safe and what is not

Nothing here checks values the game would check. An impossible class, item or spell id can crash a battle
or a menu, and a bad unit id in an empty slot can put a unit in the army that has no data behind it.
The container and checksum are always recomputed correctly, so a mistake costs you a save slot, not the file.
**Keep the copy you opened** — the page never writes to disk, everything is in memory until you download.

Bytes the page does not understand are copied through untouched: the 1301 bytes after the activity block,
the new 0x230–0x24C tail of each unit record, the big table at 0x904C the game owns, and `save/system`.

## How the format was worked out

Save file: `u32 byte-sum of everything after the header`, `u32 save version` (23 = game 1.1.0/1.2.0),
`u32 file size`, then the save data. Body layout for version 23:

| body offset | what |
| --- | --- |
| `0x0000` | item box: 400 × `{ i16 item id (-1 = empty), u8 durability, u8 amount }` |
| `0x0640` | u32 used item slots |
| `0x0644` | 60 unit records, stride `0x24C` (1.1.0 saves use `0x230`) |
| `0x9014` | player name, wrapped in the game's `\x1bN0` … `\x1bN1` name tags |
| `0x904C` | a 500 × 0xD0 table the game owns — read only |
| `0x231D9` | player: 200 barracks slots at +0xA30, playtime +0x1070, gold +0x1074, chapter +0x107C, 270 u16 support values +0x1080, difficulty/style/route +0x129C |
| `0x250A1` | activity: reputation +0x0C, instruct exp +0x12, explore/lesson/battle uses +0x27, four statue levels +0x2B |

Checked against the save in `../fe3h-save/`, not just against documentation:

- the stored header checksum equals the byte sum of the body, for both `auto` and `slot00`;
- repacking the opened container reproduces the original file **byte for byte**;
- the unit record stride found by autocorrelation (`0x24C`) and 60 records end exactly on the player-name string;
- unit item durabilities equal each item's real maximum from the game's item table (Iron Sword 40, Vulnerary 3 …);
- empty spell slots hold the game's 38 "none" marker, empty equipped arts hold 80, fresh units start at motivation 50;
- exactly 200 empty barracks slots sit where the player block says they should, and `slot00`'s playtime
  equals the playtime recorded in `save/system`;
- decoding unit slots gives Byleth at level 2 plus all 21 students and the staff at level 1 — a real chapter 1 army.

Field meanings for the player and activity blocks, and the weapon-rank order
(Sword, Lance, Axe, Bow, Brawling, Reason, Faith, Authority, Armor, Riding, Flight), come from the research
editors listed below, whose layouts target 1.1.0; the offsets were re-checked against this 1.2.0 save.
**Supports.** The 270-entry array is one entry per *support conversation*, and the number in it is the
support points banked for that pair; the game's own `SupportTalkDB` says which two people own each entry, so
the Supports tab prints them by name. Your save proves it: the only four non-zero entries are Byleth ×
Edelgard (4), Byleth × Dimitri (3), Byleth × Claude (7) and Byleth × Sothis (14) — exactly what a 14-minute
prologue save should hold. The rank cut-offs (0-100 none, 101-300 C, 301-600 B, 601-900 A, 901-1200 S,
shifting +200 per step for pairs whose chain has an extra rank) are the ones the research editors document
rather than values read out of the game, so the raw number stays visible and editable next to the rank. The
pairing table in `tools/sources/` is the 1.0.2 dump, so the fourteen conversation slots past its 256 rows are
printed by index only. Raising a pair's points may not by itself make the conversation play — the game also
gates conversations on the calendar, and that gating is not documented, so it has not been verified here.
Genuinely rough: the "Route" byte at player +0x129E still has no published value list.

Names come from the game's own message tables (`FILE_002`, 15,023 English strings) and the extracted
item/class/character dumps, at the index offsets the research editors use (`3452 + class`, `3722 + (item − 10)`,
`NameStringId + 1156`, `7202 + ability`, `5980 + combat art`, `7802 + spell`, `9062 + battalion`, …). Those dumps
date from 1.0.2, so a handful of newer entries fall back to `class 91 (newer than the name table)`.

## Development

```sh
node tools/test-codec.mjs      # 71 checks against your real save; exits non-zero on failure
node tools/build-data.mjs      # regenerate js/data-<lang>.js after changing tools/sources
node tools/test-picker.mjs     # 10 checks on the open-a-file path (needs `npm install jsdom` once)
```

Both suites are opt-in and quick: about a tenth of a second for the codec, just over a second for the picker.
The Engage editor has the same pair (`test-codec.mjs` for the bytes, a DOM test for the page), so the two folders
are checked the same way even though their save formats have nothing in common.

`tools/sources/` is the authority, and it is a *chosen subset* of the game's tables: everything the page
reads, nothing it does not. The dumps it came from (`ItemDB_*`, `ClassDB`, `CharacterDB`,
`SupportTalkDB` and the `FILE_002` message table) were deleted afterwards - the game is finished, this page
is English only, and the numbers are re-checked against a real save by `tools/test-codec.mjs`. This is the
extraction map, so every field stays auditable without the dumps:

| from | bytes taken per record | became |
| --- | --- | --- |
| `ItemDB_0010 / 0600 / 1000 / 4000 / 5000 / 6000 / 7000` | 6 rank, 7 range, 11 durability, 17 hit, 18 crit, 19 weight | `items.json` |
| `CharacterDB` | 0x12 given-name id, 0x16 title id, 0x18 surname id, 0x1b age, 0x1c class, 0x22 max HP, 0x24 affinity, 0x25 HP growth, 0x26 gender, 0x27 base HP, 0x29-0x2a crest, 0x30-0x38 base, 0x39-0x41 growth, 0x42-0x4a cap | `roster.json` Persons |
| `ClassDB` | 0x39-0x43 skill bonus, 0x47 exam, 0x4a exp, 0x4c base HP, 0x55-0x5d base stats, 0x5e-0x61 combat arts | `roster.json` Classes |
| `SupportTalkDB` | 4 flag word, 6 first person, 7 second person | `supports.json` |
| `FILE_002` (15,023 strings) | 1,975 of them, by the ranges and offsets above | `glossary.json` + the names in the rest |

Not carried over: the remaining bytes of each record (weapon-rank growths, buy prices, growth secondary
rates, crest weapon effects and the like - none of it is shown by this page), the other 13,048 message
strings, and `FILE_000` / `FILE_001`, which the generator never read. To go further you would re-extract the
dumps (the research repo `imouto1994/fe3h-editor` ships them) and extend this map.
