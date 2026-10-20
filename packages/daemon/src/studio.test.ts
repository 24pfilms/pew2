import { expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { studioProjects } from "./studio.js";

async function studio(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pew2-studio-"));
  await mkdir(join(root, "projects"));
  return root;
}

const at = (iso: string) => new Date(iso);

test("a project with no projects folder, or only files and housekeeping in it, is not a studio", async () => {
  const plain = await mkdtemp(join(tmpdir(), "pew2-plain-"));
  expect(await studioProjects(plain)).toBeUndefined();

  const root = await studio();
  await writeFile(join(root, "projects", "index.html"), "<html>");
  await mkdir(join(root, "projects", "_research"));
  await mkdir(join(root, "projects", ".ruff_cache"));
  expect(await studioProjects(root)).toBeUndefined();
});

test("studio projects are folders, newest first, dated by what changed inside them", async () => {
  const root = await studio();
  const p = (name: string) => join(root, "projects", name);
  for (const name of ["Old", "Recent", "Middle"]) await mkdir(p(name));
  await mkdir(join(p("Old"), "renders"));
  await mkdir(join(p("Recent"), "renders"));
  await writeFile(join(p("Middle"), "notes.md"), "x");
  // Folder times say Old is newest; what is inside says otherwise.
  await utimes(p("Old"), at("2026-10-19T00:00:00Z"), at("2026-10-19T00:00:00Z"));
  await utimes(join(p("Old"), "renders"), at("2026-10-01T00:00:00Z"), at("2026-10-01T00:00:00Z"));
  await utimes(p("Recent"), at("2026-10-01T00:00:00Z"), at("2026-10-01T00:00:00Z"));
  await utimes(join(p("Recent"), "renders"), at("2026-10-20T12:00:00Z"), at("2026-10-20T12:00:00Z"));
  await utimes(p("Middle"), at("2026-10-05T00:00:00Z"), at("2026-10-05T00:00:00Z"));
  await utimes(join(p("Middle"), "notes.md"), at("2026-10-05T00:00:00Z"), at("2026-10-05T00:00:00Z"));
  await writeFile(join(root, "projects", "readme.md"), "not a project");
  await mkdir(join(root, "projects", "_index"));

  const listed = await studioProjects(root);
  expect(listed?.map((project) => project.name)).toEqual(["Recent", "Old", "Middle"]);
  expect(listed?.[0]).toEqual({
    name: "Recent",
    path: p("Recent"),
    updatedAt: "2026-10-20T12:00:00.000Z",
  });
});
