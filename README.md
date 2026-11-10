# Fire Emblem save editors

Two standalone save editors for two Fire Emblem games, one folder each. Each is a single web page: you open your
save files in it, edit, and it hands the file back with the checksums rebuilt. No server, no install, no build
step, nothing uploaded — the page reads and writes the bytes itself, and works from `file://`.

| folder | game | title ID | save files | save format |
| --- | --- | --- | --- | --- |
| [`fe3h-save-editor/`](fe3h-save-editor/README.md) | Fire Emblem: Three Houses | `010055D009F78000` | `auto`, `slot00`, `slot01`… (`system` is read as metadata) | version 23 (game 1.1.0 / 1.2.0) |
| [`fee-save-editor/`](fee-save-editor/README.md) | Fire Emblem Engage | `0100A6301214E000` | `Auto`, `Manual0`, `Manual1`… (`Global` is read but never written) | format version 9 (game 1.0 through 2.0) |

**Each folder's README is the real documentation** — the layout tables, what every field means, how each offset was
proved against a real save, what is still unverified, and what comes next. This file only covers what is common to
both.

## Use

1. **Find your save files.** They are the files the game writes, wherever you keep them: the game's save-data
   folder under its title ID, a save-manager export, an emulator's user directory. Three Houses keeps `auto` plus
   `slot00`…`slotNN`; Engage keeps `Auto`, `Manual0`… and a `Global` file beside them.
2. **Open `<folder>/index.html`** by double-clicking it, then use **choose files** or drop them on the page.
   Pick the save files themselves rather than the folder around them — multi-select works, and a mixed batch is
   fine. The slot list shows chapter and playtime on every button, so you can see which one you are about to edit.
3. **Edit.** What each tab holds is in the folder's README. Every change is listed in **Changes** with its own
   **revert** button, newest first.
4. **Download.** The button gives back what you opened: the save file itself, under its own name, with its
   checksum recomputed.
5. **Put it back** where it came from, with the game closed, and **keep the copy you opened**.

If your saves come out of an **nxnative cloud save**, drop `save.dmsync` instead of the loose files: it is a
packed copy of the same folder, the page unpacks and verifies it, edits the copy inside, and hands back a packed
`<TITLE ID>-save.dmsync` ready to put back. Everything else about the page is identical either way.

## The shape both share

```
<folder>/index.html         the whole app: UI + save format + container format
<folder>/js/<game>.js       the codec; loads as window.FE3H / window.FEE in a browser and as a module in node,
                            so the tests exercise the same code the page runs
<folder>/js/data-en.js      generated names — the save only carries numbers
<folder>/tools/build-data.mjs        tools/sources/*.json  ->  js/data-<lang>.js
<folder>/tools/test-codec.mjs        the bytes, against a real save
<folder>/tools/test-page.mjs         the page itself, in a headless DOM (named test-picker.mjs in fe3h)
<folder>/tools/sources/              the name and limit tables the generator reads
```

- **Nothing is shared between the folders.** Two editors, two save formats with nothing in common, deliberately
  duplicated rather than abstracted; there is no package, no workspace, no shared library. Same file names and
  same two kinds of test in both, so you can move between them without relearning the layout.
- **Each page edits one game, and says so.** The other game's save is refused by name — in the file you dropped,
  and in a container whose contents belong to the other title — rather than being quietly skipped or parsed into
  nonsense.
- **Every download is read back before you get it**: the page recomputes the checksums, then parses its own output
  with the same reader it uses on other people's files and refuses to hand over a file that does not read clean.
  When a container was opened it is re-packed and verified the same way, byte-for-byte against what it read.
- **Bytes it does not understand are copied through untouched**, and the page never writes to disk — everything is
  in memory until you download.
- **Changes are listed with a revert button, newest first**, and one undo restores the affected bytes.

## Development

```sh
cd fe3h-save-editor          # or fee-save-editor
node tools/test-codec.mjs    # the byte-level suite; exits non-zero on failure
node tools/build-data.mjs    # regenerate js/data-<lang>.js after changing tools/sources
node tools/test-page.mjs     # the DOM suite (needs `npm install jsdom` once — neither folder has a package.json)
```

Both suites are opt-in and take a fraction of a second to a couple of seconds; each folder's README gives its own
check counts. **They read a real save, and the default path baked into them is this machine's** — pass your own as
the first argument. Note that the suites want a packed `save.dmsync`, since they check the container as well as the
save; the pages themselves are happy with loose files:

```sh
node tools/test-codec.mjs /path/to/save.dmsync
node tools/test-page.mjs  /path/to/save.dmsync
```

`tools/sources/` is the authority for every label the page prints, and it is a chosen subset of the game's own
tables — what the page reads, nothing it does not. The full dumps were not kept; each README carries the
extraction map so every field stays auditable without them. Name data is English only so far; a second language
is a name column per table, `LANGS=ja node tools/build-data.mjs`, and one extra `<script src>` in `index.html`.

## Caveats

Neither editor validates values the game would validate: an impossible item, class, skill or ring id can crash a
battle or a menu. What is protected is the file, not the save — checksums are always rebuilt correctly, and
Engage rolls a write back if the file stops parsing afterwards, so a mistake costs a slot rather than the file.
**None of this has been checked in-game.** Back up the save you opened before editing it.

GPL-3.0 — see [LICENSE](LICENSE).
