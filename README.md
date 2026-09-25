# ALTTPR PO Launcher

A portable Windows launcher for *A Link to the Past Randomizer* and Archipelago multiworld seeds. Drop a ROM on it and press Play: it stages the ROM into your MSU-1 music pack, starts the emulator (with the Lua connector for BizHawk), SNI, your timer and the built-in item tracker, then puts every window back where you last saved it.

## Using it

1. Download `ALTTPR-PO-Launcher.exe` from [Releases](https://github.com/Penderrin-Projects/alttpr-po-launcher/releases/latest). It is a single portable file; nothing is installed.
2. Open the settings panel and point it at your emulator, SNI, timer (optional), MSU packs folder and ROM staging folder.
3. Configure the tracker once (Tracker → settings); the preset is remembered.
4. Drop a `.sfc` or `.aplttp` on the window, or put it in the staging folder, pick a music pack, press **Play**.
5. Arrange your windows, then **Save Layout** (there is one layout for `.sfc` and one for `.aplttp`).

### Music packs

A pack is any folder with a `.msu` file directly inside it. Point the launcher at the folder that holds your packs; it looks up to three levels down, so `MSU\Zelda\<pack>\` works, and packs found deeper are listed as `Zelda / Pack name`. Pointing it straight at one pack folder works too. Unreadable folders (a drive's recycle bin, say) are skipped and counted. A scan can be cancelled from the pack list; whatever was found so far stays.

You don't need a pack at all: **Original soundtrack** is always the first entry, and the first-run screen can be skipped. A `.sfc` then plays from where it is; an `.aplttp` is opened in place and the launcher waits for the `.sfc` Archipelago writes next to it.

The launcher tells you when a newer release exists. Set `"checkForUpdates": false` in `%APPDATA%\alttpr-po-launcher\po-launcher-settings.json` to turn that off.

### One-time setup on a fresh PC

| What | Why |
|---|---|
| BizHawk → Config → Customize → **Save Window Position** on | The launcher never moves BizHawk's main window (see *Design notes*); BizHawk restores its own position. |
| SNI's own hide-console option (optional) | The launcher just starts SNI; whether its console window shows is SNI's setting, not the launcher's. |
| Archipelago: **AP fix** checkbox in the launcher's settings | For `.aplttp` seeds the launcher starts the emulator. If Archipelago's `host.yaml` also has `snes_rom_start` / `rom_start` on, the emulator opens twice. The checkbox sets both to `false` (and restores the old values if you untick it). The two `Arch Auto Rom *.bat` files do the same thing from outside the app. |
| .NET Framework 4 | Ships with Windows 10/11. Only needed when running from source without a prebuilt helper. |

## Building

```
npm ci
npm start          # run from source
npm run build      # -> dist/ALTTPR-PO-Launcher.exe  (compiles native/WinHelper.cs first)
```

`start.bat` does the install-and-run for you.

### Releasing

1. Bump `version` in `package.json`, commit.
2. `git tag v<version> && git push origin v<version>`
3. The **Build & draft release** workflow builds on a Windows runner, boots the packaged app in self-test mode, and creates a *draft* release with the exe attached.
4. Review the notes and press **Publish**. Publishing by hand is what triggers the Discord notification; a release published by a workflow's own token would not.

Every pull request gets the same build + self-test, with the exe attached to the run as an artifact.

### Self-test

`PO_LAUNCHER_SELFTEST=<report.json>` makes the launcher boot against a throwaway profile, check the things that only break once packaged (preload present, helper shipped and runnable, tracker page loads), write a JSON report and exit `0`/`1`. It never touches real settings.

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
- **Settings live in memory** with debounced, atomic writes (the tracker saves its bounds on every move/resize event), which is why the launcher is single-instance.

## The vendored tracker

`tracker/` is a snapshot (asset stamps `20260131`) of the community ALTTPR item tracker with PO changes layered on top. The PO-specific files are `css/po-theme.css`, `css/po-theme-secondary.css`, `css/launcher.css` and `js/po-themes.js`, plus small hooks in `index.html`, `tracker.html`, `logic.html` and `colors.html`. When re-syncing from upstream, keep those and re-apply the hooks; upstream logic fixes do not arrive on their own.

Known, harmless: the settings page logs `Cannot set properties of null (setting 'innerHTML')` — upstream's "upcoming race" code looking for an element the PO layout removed.

## License

MIT
