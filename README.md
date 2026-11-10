# Fire Emblem save editors

Two standalone save editors for two Fire Emblem games, one folder each. Each is a single web page: it reads a
save out of an nxnative cloud-save container (`save.dmsync`) or from loose save files, lets you edit it, and hands
the file back with its checksums and container rebuilt. No server, no install, no build step, nothing uploaded —
the page reads and writes the bytes itself, and works from `file://`.

| folder | game | title ID | save format |
| --- | --- | --- | --- |
| [`fe3h-save-editor/`](fe3h-save-editor/README.md) | Fire Emblem: Three Houses | `010055D009F78000` | version 23 (game 1.1.0 / 1.2.0) |
| [`fee-save-editor/`](fee-save-editor/README.md) | Fire Emblem Engage | `0100A6301214E000` | format version 9 (game 1.0 through 2.0) |

**Each folder's README is the real documentation** — the layout tables, what every field means, how each offset was
proved against a real save, what is still unverified, and what comes next. This file only covers what is common to
both.

## Use

Open **`<folder>/index.html`** by double-clicking it. Then, in either editor: drop `save.dmsync` (or the loose
save files inside it) on the page, pick a slot, edit, and press **Download save.dmsync**. Quit the game on the
phone *and* in the Mac app before dropping the downloaded `<TITLE ID>-save.dmsync` back over the original, and
keep the copy you opened. Per-game file names, tabs, and offsets are in the folder's README.

## The shape both share

```
<folder>/index.html         the whole app: UI + save format + container format
<folder>/js/<game>.js       save and .dmsync codec; loads as window.FE3H / window.FEE in a browser
                            and as a module in node, so the tests exercise the same code the page runs
<folder>/js/data-en.js      generated names — the save only carries numbers
<folder>/tools/build-data.mjs        tools/sources/*.json  ->  js/data-<lang>.js
<folder>/tools/test-codec.mjs        the bytes, against a real save
<folder>/tools/test-page.mjs         the page itself, in a headless DOM (named test-picker.mjs in fe3h)
<folder>/tools/sources/              the name and limit tables the generator reads
```

- **Nothing is shared between the folders.** Two editors, two save formats with nothing in common, deliberately
  duplicated rather than abstracted; there is no package, no workspace, no shared library. Same file names and
  same two kinds of test in both, so you can move between them without relearning the layout.
- **The container is the same in both**: `DMSYNC1` header, one entry per file, SHA-256 per entry, `DMSYNCE` tail.
  Each editor repacks it byte-for-byte — re-packing the save opened from disk reproduces that file exactly, which is
  the first thing its test suite checks. A file from the wrong game is not mistaken for a save either: Engage checks
  its section tags, and Three Houses only accepts a body whose header size matches the file and whose save version is
  12, 13 or 23.
- **Every download is read back before you get it**: the page recomputes the checksums, repacks, then parses its
  own output with the same reader it uses on other people's files and refuses to hand over a file that does not
  read clean.
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
check counts. **The codec tests read a real save, and the default path baked into them is this machine's** — pass
your own as the first argument:

```sh
node tools/test-codec.mjs /path/to/<TITLE ID>/save.dmsync
```

`tools/sources/` is the authority for every label the page prints, and it is a chosen subset of the game's own
tables — what the page reads, nothing it does not. The full dumps were not kept; each README carries the
extraction map so every field stays auditable without them. Name data is English only so far; a second language
is a name column per table, `LANGS=ja node tools/build-data.mjs`, and one extra `<script src>` in `index.html`.

## Caveats

Neither editor validates values the game would validate: an impossible item, class, skill or ring id can crash a
battle or a menu. What is protected is the file, not the save — checksums and container are always rebuilt
correctly, and Engage rolls a write back if the file stops parsing afterwards, so a mistake costs a slot rather
than the file. **None of this has been checked in-game.** Back up the save you opened before editing it.

GPL-3.0 — see [LICENSE](LICENSE).
