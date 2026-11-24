import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The environment a live test gives the real `claude` it starts: its own HOME and XDG directories and no
 * auto-updater and installation checks. Pointing only the XDG directories at a temporary one is not enough:
 * Claude Code's installer followed them for the files it wrote but wrote its launcher link under the account's
 * real home, so a run left the host's `~/.local/bin/claude` pointing into a directory the test then deleted.
 * The updater being off is what keeps it from installing at all; the HOME is a second fence.
 *
 * `restore()` puts the environment back, removes the temporary home, and throws if the host's launcher link
 * is not exactly where it was.
 */
const ENV_NAMES = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "DISABLE_AUTOUPDATER", "DISABLE_INSTALLATION_CHECKS"] as const;

export function isolateLiveClaudeEnv(): { home: string; restore: () => void } {
  // The account's home from the user database: the test runner may already have replaced $HOME, and claude does not look at it.
  const link = path.join(os.userInfo().homedir, ".local", "bin", "claude");
  const linkTarget = (): string | null => {
    try { return fs.readlinkSync(link); } catch { return null; }
  };
  const before = linkTarget();
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-live-home-"));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_CACHE_HOME = path.join(home, ".cache");
  process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
  process.env.DISABLE_AUTOUPDATER = "1";
  process.env.DISABLE_INSTALLATION_CHECKS = "1";
  return {
    home,
    restore() {
      for (const name of ENV_NAMES) {
        if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
      }
      fs.rmSync(home, { recursive: true, force: true });
      const after = linkTarget();
      if (after !== before) throw new Error(`a live test moved ${link}: ${before} -> ${after}`);
    },
  };
}
