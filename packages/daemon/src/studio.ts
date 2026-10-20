/**
 * Studios: projects that hold projects.
 *
 * Orcastrator keeps one folder per piece of work under `projects/` (38 of them)
 * and runs every chat at its own top level, where its tools and instructions
 * live — a chat started inside one of those folders would not find them. So to
 * pew2 the whole studio looked like a single project, and the work inside it
 * was invisible from the phone.
 *
 * Any project folder with a `projects/` folder of folders is treated as a
 * studio; nothing here is specific to Orcastrator. Only folder names and
 * modification times are read — never file contents — and only directly under
 * that one folder, so a listing can never reach outside the project.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { wire } from "@pew2/protocol";

/** The folder inside a project that makes it a studio. */
export const STUDIO_DIR = "projects";
/** Most studio projects listed, newest first. */
export const MAX_STUDIO_PROJECTS = 200;
/** Entries looked at inside each studio project to date it. */
const MAX_DATED_CHILDREN = 200;

/** A folder that is housekeeping, not a piece of work: `_index`, `.ruff_cache`. */
function isHousekeeping(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_");
}

/**
 * The projects inside `projectCwd`, newest first, or undefined when it is not
 * a studio (no `projects/` folder, or nothing but files and housekeeping in it).
 *
 * "Newest" is the latest change to the folder itself or anything directly in
 * it: adding a render to `renders/` touches `renders/`, not the project folder.
 */
export async function studioProjects(projectCwd: string): Promise<wire.StudioProject[] | undefined> {
  const root = join(projectCwd, STUDIO_DIR);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // Real folders only: a link could point anywhere on the disk.
  const folders = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !isHousekeeping(entry.name));
  if (folders.length === 0) return undefined;

  const dated = await Promise.all(
    folders.map(async (folder) => {
      const path = join(root, folder.name);
      let newest = 0;
      try {
        newest = (await stat(path)).mtimeMs;
        const children = (await readdir(path)).slice(0, MAX_DATED_CHILDREN);
        for (const child of children) {
          try {
            newest = Math.max(newest, (await stat(join(path, child))).mtimeMs);
          } catch {
            // Gone between the listing and the look: it no longer dates anything.
          }
        }
      } catch {
        // Unreadable folder: still listed, undated, last.
      }
      return { name: folder.name, path, newest };
    }),
  );
  dated.sort((a, b) => b.newest - a.newest || a.name.localeCompare(b.name));
  return dated.slice(0, MAX_STUDIO_PROJECTS).map(({ name, path, newest }) => ({
    name,
    path,
    ...(newest > 0 ? { updatedAt: new Date(newest).toISOString() } : {}),
  }));
}
