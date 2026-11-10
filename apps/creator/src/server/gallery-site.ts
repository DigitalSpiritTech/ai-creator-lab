/**
 * The static gallery site (GitHub Pages): plain HTML pages rendered from the examples, with no
 * JavaScript. `renderGallerySite` is pure (examples in, files out as strings); the builder script
 * (`apps/creator/scripts/build-gallery.ts`) writes them and copies each example's output files.
 * Drafts render as "Not yet generated" with no outputs or cost, as in the app.
 * @packageDocumentation
 */
import { type GalleryExample, exampleLibraryItems, exampleStatusLabel } from "@creator-lab/core/domain/gallery";

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#fafaf9;color:#1c1917}main{max-width:960px;margin:0 auto;padding:32px 20px}a{color:#166534}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:0}p.lede{color:#57534e;margin:0 0 24px}.card{background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:16px 18px;margin:0 0 16px}.badge{display:inline-block;font-size:12px;border:1px solid #d6d3d1;border-radius:999px;padding:1px 8px;margin-left:6px;color:#44403c}.draft{background:#fef9c3;border-color:#fde047}.muted{color:#57534e}.outputs{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}.outputs img,.outputs video{height:240px;border-radius:8px;background:#e7e5e4}dl{display:grid;grid-template-columns:160px 1fr;gap:6px 16px;margin:12px 0}dt{font-weight:600}dd{margin:0}code{font-size:13px}footer{color:#78716c;font-size:13px;margin-top:32px}`;

/** Site options: the repository link for the footer (the Pages workflow passes its own repository URL). */
export interface GallerySiteOptions {
  repoUrl?: string;
}

function page(title: string, body: string, root: string, options: GallerySiteOptions): string {
  const name = options.repoUrl && /^https:\/\/[^\s"'<>]+$/.test(options.repoUrl) ? `<a href="${escapeHtml(options.repoUrl)}">AI Creator Lab</a>` : "AI Creator Lab";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer>Made with ${name}, an open-source UGC studio that runs on your own Comfy account. Every person and product here is invented. <a href="${root}index.html">All examples</a></footer>
</main>
</body>
</html>
`;
}

function badges(example: GalleryExample): string {
  const status = `<span class="badge${example.status === "draft" ? " draft" : ""}">${escapeHtml(exampleStatusLabel(example))}</span>`;
  return `${example.mode === "quick" ? '<span class="badge">Quick Ad</span>' : ""}${status}`;
}

function costText(example: GalleryExample): string {
  const { cost } = example;
  if (!cost) return "Not yet generated";
  return `${cost.credits} credits (${cost.usd.toFixed(2)} USD), settled from the balance (${cost.balanceBeforeCredits} before, ${cost.balanceAfterCredits} after) on ${escapeHtml(cost.measuredOn)}; ${escapeHtml(cost.verificationRow)}`;
}

function outputs(example: GalleryExample): string {
  if (example.status === "draft" || !example.outputs.length) {
    return `<p class="muted"><strong>Not yet generated.</strong> This example has its brief, recipes, and Library items, but no outputs or cost until it is run on a real Comfy account.</p>`;
  }
  const items = example.outputs.map((output) => {
    const src = `files/${encodeURIComponent(output.file)}`;
    const label = escapeHtml(output.caption);
    return output.file.endsWith(".mp4")
      ? `<video src="${src}" controls preload="metadata" aria-label="${label}"></video>`
      : `<img src="${src}" alt="${label}" width="${output.width}" height="${output.height}" loading="lazy">`;
  });
  return `<div class="outputs">${items.join("")}</div>`;
}

/** One example's page, at `examples/<id>/index.html`. */
export function renderExamplePage(example: GalleryExample, options: GallerySiteOptions = {}): string {
  const library = exampleLibraryItems(example).map((item) => `${escapeHtml(item.name)} (${item.kind})`).join(", ") || "none";
  const recipes = example.recipes
    .map((choice) => `<li>${escapeHtml(choice.step)}: <code>${escapeHtml(choice.recipeId)}</code>${choice.backend ? ` on ${escapeHtml(choice.backend)}` : ""}${choice.note ? ` <span class="muted">${escapeHtml(choice.note)}</span>` : ""}</li>`)
    .join("");
  const flaws = example.flaws.length ? `<ul>${example.flaws.map((flaw) => `<li>${escapeHtml(flaw)}</li>`).join("")}</ul>` : example.status === "draft" ? "Not yet generated" : "None listed";
  const { brief } = example;
  const body = `<h1>${escapeHtml(example.title)}${badges(example)}</h1>
<p class="lede">${escapeHtml(example.summary)}</p>
<div class="card">
${outputs(example)}
<dl>
<dt>Brief</dt><dd>${escapeHtml(brief.productSummary)}. For ${escapeHtml(brief.audience)}. On ${escapeHtml(brief.platforms.join(", "))}. Tone: ${escapeHtml(brief.tone)}.</dd>
<dt>Library items</dt><dd>${library}</dd>
<dt>${example.status === "draft" ? "Recipes planned" : "Recipes"}</dt><dd><ul>${recipes}</ul></dd>
<dt>Cost</dt><dd>${costText(example)}</dd>
<dt>Flaws</dt><dd>${flaws}</dd>
${example.madeBy ? `<dt>Made by</dt><dd>${escapeHtml(example.madeBy)}</dd>` : ""}
</dl>
</div>`;
  return page(`${example.title}: AI Creator Lab gallery`, body, "../../", options);
}

/** The index page, listing every example with its status. */
export function renderGalleryIndex(examples: readonly GalleryExample[], options: GallerySiteOptions = {}): string {
  const cards = examples
    .map(
      (example) => `<div class="card"><h2><a href="examples/${encodeURIComponent(example.id)}/index.html">${escapeHtml(example.title)}</a>${badges(example)}</h2>
<p class="muted">${escapeHtml(example.summary)}</p>
<p class="muted">Cost: ${example.cost ? `${example.cost.credits} credits (${example.cost.usd.toFixed(2)} USD) from the balance` : "Not yet generated"}</p></div>`,
    )
    .join("\n");
  const body = `<h1>AI Creator Lab gallery</h1>
<p class="lede">Ads made with the studio on real Comfy accounts: the brief, the recipe for each step, what it cost by the credit balance before and after, the outputs, and what is wrong with them. Drafts are planned and not yet generated.</p>
${cards || '<p class="muted">No examples yet.</p>'}`;
  return page("AI Creator Lab gallery", body, "", options);
}

/** Every file of the site as path and contents, plus the example outputs to copy (from, to). */
export function renderGallerySite(
  examples: readonly GalleryExample[],
  options: GallerySiteOptions = {},
): { pages: { path: string; html: string }[]; copies: { exampleId: string; file: string; to: string }[] } {
  const pages = [
    { path: "index.html", html: renderGalleryIndex(examples, options) },
    ...examples.map((example) => ({ path: `examples/${example.id}/index.html`, html: renderExamplePage(example, options) })),
  ];
  const copies = examples.flatMap((example) => example.outputs.map((output) => ({ exampleId: example.id, file: output.file, to: `examples/${example.id}/files/${output.file}` })));
  return { pages, copies };
}
