/**
 * Builds the static gallery site from `examples/` into `site/` (or `GALLERY_OUT`) for GitHub Pages:
 * an index, one page per example, each example's output files, and `.nojekyll`. Every example must
 * pass its schema check; a broken one stops the build with the folder and the problem, so a bad
 * example never ships silently. Drafts render as "Not yet generated".
 *
 * Usage: npm run gallery:build   (GALLERY_REPO_URL=https://... adds the repository link)
 * @packageDocumentation
 */
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { examplesDir, loadGallery } from "@/server/gallery";
import { renderGallerySite } from "@/server/gallery-site";

async function main(): Promise<void> {
  const source = examplesDir();
  const out = resolve(process.env.GALLERY_OUT || "site");
  const { examples, problems } = await loadGallery(source);
  if (problems.length) {
    for (const problem of problems) console.error(`examples/${problem.folder}: ${problem.message}`);
    throw new Error(`${problems.length} example folder(s) failed the schema check.`);
  }
  const { pages, copies } = renderGallerySite(examples, { repoUrl: process.env.GALLERY_REPO_URL });
  await rm(out, { recursive: true, force: true });
  for (const { path, html } of pages) {
    const target = join(out, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, html);
  }
  for (const copy of copies) {
    const target = join(out, copy.to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, copy.exampleId, copy.file), target);
  }
  await writeFile(join(out, ".nojekyll"), "");
  const drafts = examples.filter((example) => example.status === "draft").length;
  console.log(`Gallery site: ${examples.length} example(s) (${drafts} draft, not yet generated), ${copies.length} file(s), in ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
