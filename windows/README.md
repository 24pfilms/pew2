# pew2 on Windows — notes for this fork

This is a private copy of [KenKaiii/pew2](https://github.com/KenKaiii/pew2) that runs the daemon from source on
Windows and a locally built Android app. Everything upstream still applies; this page covers what is different
and what was learned getting it solid.

## What this fork adds on top of upstream

| Change | Where | Why |
| --- | --- | --- |
| Four Windows fixes for a supervised daemon (case-insensitive `Path`, workspace never `C:\WINDOWS\system32`, `PEW2_BROWSE_ROOTS` split on `;`, browse roots passed to the service) | `packages/daemon` | Only failed once the daemon ran from Task Scheduler instead of a shell. |
| Arm the Windows keepalive at install, not only at next logon | `packages/daemon/src/cli/service-schtasks.ts` | A daemon that died mid-session otherwise stayed dead until the next login. |
| Phone re-asks every agent for its history after a reconnect | `packages/app/src/capabilityProbes.ts` | The list was frozen at app launch: a project started at the desk never appeared on the phone. |
| Pull the drawer's chat list down to refresh it | `packages/app/src/listRefresh.ts`, `ui/Sidebar.tsx` | Forces the agent to re-read its history instead of waiting for the daemon's one-minute cache, then re-asks the chosen project. |
| A forced refresh that fails keeps the last list | `packages/daemon/src/index.ts` (`refreshedCapabilities`) | An agent that failed to boot mid-pull answered "no projects" and blanked the phone's list. |
| `PEW2_IMAGE_ROOTS` split on `;` | `packages/daemon/src/images.ts` | Same drive-letter bug as `PEW2_BROWSE_ROOTS`: an extra image folder on `L:\` was never allowed. |
| Metro server root pinned to the app package | `packages/app/metro.config.js` | Release bundling (`expo export:embed`) otherwise resolves `index.ts` from the repo root. Same effect as upstream's `EXPO_NO_METRO_WORKSPACE_ROOT=1`. |
| GG Coder crash guard + safe restart script | `windows/` | See below. |

## How the setup fits together

```
phone app ──(wss, encrypted)──► your Cloudflare relay ◄──── pew2 daemon on this PC ──► agents
                                                             (Task Scheduler: \dev.pew2.daemon)
```

- **Daemon:** `pew2 setup` installs the per-user scheduled task `\dev.pew2.daemon`. It retries every minute and
  ignores new starts while one is running, so it restarts itself within a minute of exiting. Logs:
  `%USERPROFILE%\.pew2\logs\daemon.log` and `daemon.error.log`.
- **Projects on another drive:** set `PEW2_BROWSE_ROOTS` (semicolon-separated, e.g. `L:\`) before `pew2 setup`
  so the service inherits it.
- **Pictures on the phone:** an agent's image shows in the chat when the agent returns it from a tool, or names
  the file in its reply (`![](path/to/shot.png)`). The daemon only reads files inside the conversation's project
  folder and the temp folder. To allow another folder (say, where screenshots are saved), set `PEW2_IMAGE_ROOTS`
  (semicolon-separated) the same way as `PEW2_BROWSE_ROOTS`. Formats: png, jpg, gif, webp, bmp, heic, up to 8 MB.
- **Relay:** the phone is paired with a relay link, so it always connects through the relay — on home Wi-Fi and
  on mobile data alike. A direct same-Wi-Fi link would need a re-pair and an app built with cleartext `ws://`
  allowed; the relay is the better default.

## Building and installing the Android app

Needs JDK 17 and the Android SDK (platform 36, build-tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1).

```powershell
cd packages\app
npx expo prebuild --platform android          # only when app.json plugins or native deps' config change
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME    = "C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot"
.\android\gradlew.bat -p android assembleRelease
```

- **Keep `packages\app\android\app\debug.keystore`.** Release builds sign with it. An APK signed with a different
  key cannot replace the installed app, and uninstalling first erases the pairing. Back it up before any
  `expo prebuild --clean`. Check with `apksigner verify --print-certs app-release.apk`.
- **Install over the existing app, never uninstall first.** With USB debugging: `adb install -r app-release.apk`.
  Without it (some OPPO/ColorOS phones would not expose adb), copy the APK to the phone's `Download` folder over
  USB file transfer and tap it; Android should say it is installing an *update*.
- **Known release-build failures and fixes:**
  - `Unable to resolve module ./index.ts from <repo>/.` — the Metro server-root issue, fixed in this fork's
    `metro.config.js`.
  - `createReleaseUpdatesResources` fails with a doubled path (`packages\app\packages\app\index.ts`) — an
    expo-updates monorepo bug. Local patch in
    `node_modules\expo-updates\utils\build\createManifestForBuildAsync.js`: after the `isAbsolute` block, fall back
    to `path.basename(entryFile)` when the joined path does not exist. Lost on reinstall of expo-updates.
- A new native dependency (e.g. `@shopify/react-native-skia`) means a new APK; a JS-only change still needs a
  rebuild because the bundle is embedded.

## GG Coder crash guard (`windows/ggcoder-guard.mjs`)

GG Coder's self-updater runs `spawn("npm", ["install", "-g", "@kenkaiiii/ggcoder@latest"])` without a shell. On
Windows `npm` is `npm.cmd`, so the spawn emits an unhandled `ENOENT` and **kills the agent**. It re-arms every hour
while a newer GG Coder is on npm, so pew2's GG Coder probe dies with "ACP connection closed" and the phone's GG Coder
project list goes stale. Still present in gg-core 5.64.1.

The guard is a `node --import` preload that gives package-manager child processes an `'error'` listener, so a
failed background self-update is logged and skipped. It is used only for pew2's launches; OrcaCoder V3 and the plain
`ggcoder` command are unaffected. Install:

1. Copy `windows\ggcoder-guard.mjs` to `%USERPROFILE%\.pew2\adapters\ggcoder-guard\guard.mjs`.
2. Copy `windows\ggcoder.provider.json` to `%USERPROFILE%\.pew2\providers\ggcoder.json`, replacing `<USER>`.
3. Restart the daemon (below). `pew2 providers verify ggcoder` should print `ok`.

To undo, set the provider back to `"command": "ggcoder", "args": ["acp"]`. Updating GG Coder stays manual:
`npm install -g @kenkaiiii/ggcoder@latest`.

## Restarting the daemon safely (`windows/Restart-Pew2Daemon.ps1`)

Stopping only `bun.exe` can leave port 8787 stuck: an agent probe launched through a `.cmd` shim (seen with
`codex-acp` and the MCP servers it starts) can outlive the daemon holding an inherited copy of the listening socket.
The next daemon then fails with `EADDRINUSE`, and the listener shows a process that no longer exists.

```powershell
pwsh -File windows\Restart-Pew2Daemon.ps1 -WhatIf   # shows what it would stop
pwsh -File windows\Restart-Pew2Daemon.ps1           # stop daemon + orphaned agent trees, restart, wait for /health
```

It never touches processes whose parent is still running (for example MCP servers owned by a Claude Code session).

## Upgrading from upstream

```powershell
git fetch origin                                  # origin = KenKaiii/pew2
git branch backup/pre-upgrade-<date>              # rollback point
git merge-tree --write-tree --name-only HEAD origin/main   # dry run: lists conflicts, changes nothing
git merge origin/main
bun install
bun run typecheck; bun run test
pwsh -File windows\Restart-Pew2Daemon.ps1
git push mine main                                # mine = this private repo
```

Usual conflict spots: `bun.lock` (take upstream's, then `bun install`), `packages/app/package.json` (keep both
sides' dependencies), `packages/app/src/useDaemon.ts`. Check whether `packages/protocol` changed: if the wire
format changed, rebuild the app before the phone reconnects to the new daemon. Upgrade the APK only when
`packages/app` changed.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Phone: "code did not connect… running pew2?" | Daemon down, or port 8787 stuck | `Restart-Pew2Daemon.ps1`; check `daemon.error.log` for `EADDRINUSE` |
| GG Coder list stale / "ACP connection closed" | GG Coder self-update crash | Install the guard (above) |
| Projects on another drive missing | `PEW2_BROWSE_ROOTS` not reaching the service | Set it, re-run `pew2 setup` |
| New app won't install ("App not installed") | Different signing key | Rebuild with the original `debug.keystore`; do not uninstall |
| Cline / Qwen "Authentication required" | Not signed in to those CLIs | Sign in with each CLI; unrelated to pew2 |
