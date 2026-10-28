# ALTTPR PO Launcher

A portable Windows launcher for *A Link to the Past Randomizer* and Archipelago multiworld seeds. Drop a ROM on it and press Play: it stages the ROM into your MSU-1 music pack, starts the emulator (with the Lua connector for BizHawk), SNI, your timer and the built-in item tracker, then puts every window back where you last saved it.

## Using it

1. Download from [Releases](https://github.com/Penderrin-Projects/alttpr-po-launcher/releases/latest). Three forms of the same app:
   - **`ALTTPR-PO-Launcher-Setup.exe`** — a normal installer: Start menu and desktop shortcuts, uninstall from Windows Settings. Installs for the current user by default (no admin needed) and launches in about a second.
   - **`ALTTPR-PO-Launcher-win64.zip`** — nothing installed: extract the folder anywhere and run `ALTTPR PO Launcher.exe` inside it. Also launches in about a second.
   - **`ALTTPR-PO-Launcher.exe`** — a single portable file. Convenient, but it unpacks itself to a temporary folder on every launch, which takes 5-8 seconds.

   All three keep their settings and layouts in `%APPDATA%\alttpr-po-launcher`, so switching between them loses nothing.
2. The first launch walks you through setup: emulator, SNI, timer, seeds folder, music packs, the tracker preset and layouts. Every step can be skipped; the guide is always available again from **Settings → Setup guide**, and it runs once as a quick check after each update.
3. The tracker is [Muffins Tracker 2.0](https://github.com/KrisDavie/alttptracker/tree/react_rewrite). Out of the box it opens in standard open mode with autotracking on. For anything else open **Tracker setup** (the tracker's own Launch page), pick a preset or set the game up yourself, and press **Launch**; from then on **Play** and **Tracker** open a fresh tracker with those settings. Autotracking needs SNI 0.0.96 or newer.
4. Drop a `.sfc` or `.aplttp` on the window, or put it in the staging folder, pick a music pack, press **Play**.
5. Arrange your windows, then **Save Layout** (there is one layout for `.sfc` and one for `.aplttp`).

An external timer (LiveSplit, say) is optional: tick the box next to **Timer** in Settings and browse to it, and a **TIMER** switch appears on the main screen for each launch. Untick it and no timer is started or restored; the AP Timer below is separate and always there.

### Music packs

A pack is any folder with a `.msu` file directly inside it. Point the launcher at the folder that holds your packs; it looks up to three levels down, so `MSU\Zelda\<pack>\` works, and packs found deeper are listed as `Zelda / Pack name`. Pointing it straight at one pack folder works too. Unreadable folders (a drive's recycle bin, say) are skipped and counted. A scan can be cancelled from the pack list; whatever was found so far stays.

You don't need a pack at all: **Original soundtrack** is always the first entry, and the first-run screen can be skipped. A `.sfc` then plays from where it is; an `.aplttp` is opened in place and the launcher waits for the `.sfc` Archipelago writes next to it.

The launcher tells you when a newer release exists. Set `"checkForUpdates": false` in `%APPDATA%\alttpr-po-launcher\po-launcher-settings.json` to turn that off.

### Race timer (Archipelago multiworld)

**Timer** opens a stopwatch for a multiworld race, so nobody has to run LiveSplit separately. The room address and your slot name are filled in from the last `.aplttp` you launched (the patch carries both when it was downloaded from a hosted room page; a self-hosted seed only carries the slot name, so type the address once and it is remembered). The window joins as a text-only client next to your game. One person presses **Host this race** and holds the stopwatch: **Start race** sends `!countdown` to the room and the start is recorded when the server says GO (or use **Start now**). Every player's finish is recorded the moment their client reports the goal, and the host can **DNF** a player, **Finish now** for someone whose client dropped, or **Set time…** by hand. Once everyone is accounted for, a results board appears with a **Copy** button.

Players don't need the launcher. The host posts the start and each finish to the room chat, so they see it in their Archipelago client. Anyone who *does* have the launcher and opens the timer sees the host's clock and results live (the record is kept in the room's data storage, so it also survives the host closing the window). Disconnects and reconnects never touch the times.

All times are on the **server's clock** (every window anchors to it when it connects), so two PCs whose Windows clocks disagree still show the same running clock, and finish times are the same everywhere.

Friends who use the separate **Archipelago Timer and Stat Tracker** app: set **Timer-app session** to the session name they use (its default is `main`). A race they start there starts here too, counting down to their scheduled start; a countdown started here already starts theirs, because their app follows the room's `!countdown`. (Their app also reads goal completions from the room, so results match.)

**Compact** shrinks the window to the clock and the player list, sized to fit, for while you play; **Full** brings the controls back. Each mode remembers its own position and size, and the pin keeps the window above the game. **Save SFC layout** / **Save AP layout** include the timer window (with its mode) when it is open, so launching a seed brings it back where it was.

### One-time setup on a fresh PC

| What | Why |
|---|---|
| BizHawk → Config → Customize → **Save Window Position** on | The launcher never moves BizHawk's main window (see *Design notes*); BizHawk restores its own position. |
| SNI's own hide-console option (optional) | The launcher just starts SNI; whether its console window shows is SNI's setting, not the launcher's. |
| Archipelago: **AP fix** checkbox in the launcher's settings | For `.aplttp` seeds the launcher starts the emulator. If Archipelago's `host.yaml` also has `snes_rom_start` / `rom_start` on, the emulator opens twice. The checkbox sets both to `false` (and restores the old values if you untick it). The two `Arch Auto Rom *.bat` files do the same thing from outside the app. |
| .NET Framework 4 | Ships with Windows 10/11. Only needed when running from source without a prebuilt helper. |

## Startup time

The portable exe is slow to open because of how it works, not because of the app: on every launch it unpacks about 400 MB into a fresh temporary folder (and Defender scans each file as it lands), then runs the app from there and deletes the folder on exit. Measured on an NVMe SSD: 7.3 s before the app process exists, then 0.5 s to the window. The installer and the zip are the same app already unpacked, so they skip all of that.

## Building

```
npm ci
npm start          # builds the tracker if needed, then runs from source
npm run build      # -> dist/  (builds the tracker and native/WinHelper.cs first)
```

The tracker is built from source by `scripts/build-tracker.js` (see below); it needs `git` and [bun](https://bun.sh) on the PATH (`npm i -g bun` works). `start.bat` does the install-and-run for you.

### Releasing

1. Bump `version` in `package.json`, commit.
2. `git tag v<version> && git push origin v<version>`
3. The **Build & draft release** workflow builds on a Windows runner, boots the packaged app in self-test mode, and creates a *draft* release with the exe attached.
4. Review the notes and press **Publish**. Publishing by hand is what triggers the Discord notification; a release published by a workflow's own token would not.

Every pull request gets the same build + self-test, with the exe attached to the run as an artifact.

### Self-test

`PO_LAUNCHER_SELFTEST=<report.json>` makes the launcher boot against a throwaway profile, check the things that only break once packaged (preload present, helper shipped and runnable, the tracker's Launch page and tracker route render from `po://tracker/`), write a JSON report and exit `0`/`1`. It never touches real settings. `PO_LAUNCHER_SELFTEST_SHOTS=<dir>` also saves screenshots of the windows it opened; `PO_LAUNCHER_SELFTEST_TAB=<tab name>` opens that Launch page tab first, `PO_LAUNCHER_SELFTEST_PREFS=<json>` seeds remembered tracker preferences, and `PO_LAUNCHER_SELFTEST_PROBE=<js>` evaluates an expression in the tracker window and reports it.

### Debug dumps

`capture-raw.txt`, `layout-debug.json`, `restore-debug.json` and `*-error.txt` go to `%APPDATA%\alttpr-po-launcher\logs`. Always on from source; in a packaged build set `PO_LAUNCHER_DEBUG=1` or `"debugLogs": true` in the settings file.

## Layout

| Path | |
|---|---|
| `main.js` | Main process: settings, windows, ROM staging, companion launch, layout save/restore, IPC |
| `launcher-preload.js`, `renderer.*`, `styles.css` | The launcher window. The page has no Node.js; the preload exposes an allow-listed `invoke()`, one notification, and `getPathForFile()` |
| `preload.js` | Preload for the tracker windows (zoom / fit-to-window) |
| `native/WinHelper.cs` | Win32 helper: `capture` and `restore` external windows. Prebuilt into releases by `scripts/build-helper.js` |
| `tracker/` | Vendored item tracker (see below) |

## Design notes — why things are the way they are

These were learned the hard way during the original build. Please read before "simplifying".

- **BizHawk's main window is never moved.** `MoveWindow`/`ShowWindow` on it during form initialisation crashes BizHawk's splitter. `ApplyRestore` skips any non-minimised EmuHawk window; BizHawk positions itself. Only the Lua Console is touched, and only after its title has settled.
- **The real Lua script goes straight to `--lua=`.** A delayed `dofile()` loader cannot work: `Connector.lua` loads native DLLs that depend on BizHawk's own script-loading context. Loading the script into an already-positioned console was tried three ways (`WM_DROPFILES`, SendKeys, menu `WM_COMMAND`) and abandoned.
- **Companions are started through `cmd.exe` on purpose** (`launchApp`). Node puts direct, non-detached children into a kill-on-close job object: a directly spawned emulator dies the instant the launcher closes. Through `cmd.exe`, the wrapper is the job member and the app outlives the launcher. Output is ignored rather than piped, because `exec()` buffers 1 MB and then breaks the child's stdout.
- **SNI is just launched.** Four ways of hiding its console were tried; SNI has its own option. It is deliberately not part of layout capture.
- **The pack folder holds exactly one ROM.** MSU-1 needs the ROM to carry the pack's name, and the Archipelago flow treats "an `.sfc` appeared in the pack folder" as "generation finished", so stale ROMs are always cleared — *after* the new one has been copied in.
- **The tracker is scaled with a CSS transform, not Electron zoom.** Electron zoom clipped the boss icons in the fixed-pixel layout.
- **The tracker loads from `file://`, and must keep doing so.** It stores colours, logic settings and presets in `localStorage`; serving it from a custom scheme would change its origin and wipe them for every user. `webSecurity` is on: the three remote hosts it reads (`alttpr.racing`, two `alttpr-patch-data` S3 buckets) already send `Access-Control-Allow-Origin: *`, and all cross-window traffic is `postMessage`.
- **The window is a fixed 476×540 with rounded corners.** Rounded corners on a frameless window need `transparent: true`, and Electron cannot resize transparent windows from their edges, so the launcher is not resizable; the pack list scrolls instead. Don't set `resizable: true` without also adding your own edge handles.
- **Themes are one charcoal ground plus an accent** (`poThemes` in `renderer.js`, `src/lib/poTheme.ts` on the tracker fork's `po` branch and the table in `racetimer/racetimer.html` — keep the accents identical). Pre-2.3.0 theme names are mapped in `LEGACY_THEMES`.
- **Restore matches an exact window title before a partial one, and skips hidden helper windows** (`GDI+ Window (...)`, `Default IME`, and so on). A short title like `LiveSplit` is a substring of that app's own hidden GDI+ window's title; matching that one moved a 1×1 invisible window and left the real one alone. After placing a window the helper watches it for three seconds and puts it back if the app moves or resizes itself on startup (a timer applying its own layout, for example). Both rules are generic; BizHawk's main window is still never touched.
- **Settings live in memory** with debounced, atomic writes (the tracker saves its bounds on every move/resize event), which is why the launcher is single-instance.

## The tracker

The tracker is **Muffins Tracker 2.0**, the React rewrite of the community tracker ([KrisDavie/alttptracker](https://github.com/KrisDavie/alttptracker), branch `react_rewrite`), which replaces the retired jQuery tracker the launcher vendored up to 2.7. It is not vendored any more: `scripts/build-tracker.js` builds it from the commit pinned in `tracker-source.json` into `tracker/` (ignored by git) during `npm start`, `npm run build` and CI.

The pinned commit lives on the `po` branch of our fork, [Penderrin-Projects/alttptracker](https://github.com/Penderrin-Projects/alttptracker/tree/po): upstream `react_rewrite` plus a few commits of ours, described in that branch's `PO.md`:

- **Default dungeon prize marker** — a remembered setting on the Launch page's Tracker Settings tab (blue crystal by default) for the marker drawn while a dungeon's prize is unknown. Only the picture changes; clicking still cycles from "?" and autotracking still writes the real prize.
- **Launcher colours** — `window.applyPoTheme(name)`, which main.js calls in every tracker window, recolours the tracker to the launcher's accent. Inert on the hosted tracker.
- **`/tracker?last=1`** — a fresh session from whatever the Launch page launched last. That is how **Play** / **Tracker** open the tracker straight into the user's usual game; the Launch page (**Tracker setup**) is where it is changed.
- **Scale above 1:1** — the tracker grows with its window (upstream stops at 1:1).
- **Map marker size** — Tracker Settings slider, 50-200% of normal (default 100%), for the location markers on the maps.
- **Launcher look** — inside the launcher the Launch page drops the site header, notices and footer, folds the preset categories into dropdowns and uses the launcher's fonts, radii and labels; the hosted tracker is unchanged.

To update: in the fork, `git fetch upstream && git rebase upstream/react_rewrite` on `po`, push, then put the new sha in `tracker-source.json`. Upstream logic and preset fixes arrive with each bump.

How the launcher runs it: the build is a single-page app with real routes (`/` Launch page, `/tracker`, `/map`, `/event-log`), so main.js serves `tracker/` from its own `po://tracker/` scheme (any non-file path returns `index.html`) rather than `file://`. All tracker windows share that origin, so the tracker's sessions and remembered settings (IndexedDB / localStorage) are shared too. `window.open()` from a tracker page is turned into a top-level window of ours (`trackerWindowOpenHandler`), so the tracker no longer closes with the settings window. The tracker page reports its natural size (`preload.js`), and main.js shapes the window to it and locks the aspect ratio. Chromium's Local Network Access checks are disabled for the app so the tracker can reach SNI / QUsb2snes on localhost from that origin.

Not carried over from the old tracker: the **↻ seed scan** (AUTO-CONFIGURE from the running ROM), which 2.0 does not have yet, and the alttpr.com flag import.

## License

MIT
