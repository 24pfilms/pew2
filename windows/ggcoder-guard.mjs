// Preloaded (node --import) only for pew2's GG Coder launches. Install to
// %USERPROFILE%\.pew2\adapters\ggcoder-guard\guard.mjs and point
// %USERPROFILE%\.pew2\providers\ggcoder.json at it (see ggcoder.provider.json).
// OrcaCoder V3 and the plain `ggcoder` command are untouched.
//
// Why: GG Coder's self-updater (@kenkaiiii/gg-core performUpdateInBackground,
// still present in 5.64.1) runs `spawn("npm", ["install", "-g", ...])` with no
// shell. On Windows `npm` is npm.cmd, so the spawn fails with an asynchronous
// ENOENT 'error' event. Nothing listens for it, so Node treats it as unhandled
// and kills the agent mid-handshake; pew2 then reports "ACP connection closed"
// and the phone's GG Coder project list stops refreshing. It re-arms hourly
// whenever a newer GG Coder exists on npm.
//
// Fix: give package-manager child processes an 'error' listener, so a failed
// background self-update is logged and skipped instead of crashing the agent.
// Updating GG Coder stays a manual choice: npm install -g @kenkaiiii/ggcoder@latest
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;
const PACKAGE_MANAGER = /^(npm|pnpm|yarn)(\.cmd)?$/i;

childProcess.spawn = function guardedSpawn(command, ...rest) {
  const child = originalSpawn.call(this, command, ...rest);
  if (typeof command === "string" && PACKAGE_MANAGER.test(command)) {
    child.on("error", (error) => {
      process.stderr.write(
        `[ggcoder-guard] background self-update skipped (${error.code ?? error.message})\n`,
      );
    });
  }
  return child;
};

// ESM `import { spawn } from "child_process"` bindings follow the CommonJS
// export only after this sync.
syncBuiltinESMExports();
