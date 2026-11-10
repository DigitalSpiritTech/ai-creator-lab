/**
 * The gallery (v0.2 F10): the examples folder schema, the shipped draft, the loader's problems, the
 * static site (drafts "not yet generated"), and "Start from this example" through the routes: the
 * example's Library items into this Library, then `POST /api/projects` with the inbound context.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { type GalleryExampleInput, GalleryExampleSchema, exampleInbound, exampleLibraryItems, exampleStatusLabel } from "@creator-lab/core/domain/gallery";
import { loadGallery } from "@/server/gallery";
import { escapeHtml, renderExamplePage, renderGallerySite } from "@/server/gallery-site";

// Route modules import `server-only`; outside the React server build it would throw on import.
const empty = pathToFileURL(resolve("node_modules/server-only/empty.js")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: empty, shortCircuit: true, format: "commonjs" };
    return next(specifier, context);
  },
});

const EXAMPLES = resolve("examples");
const SHA = "a".repeat(64);

async function shippedDraft(): Promise<GalleryExampleInput> {
  const { examples } = await loadGallery(EXAMPLES);
  const draft = examples.find((example) => example.id === "ridgeline-quick-ad");
  assert.ok(draft, "the draft example ships in examples/");
  return draft;
}

function published(base: GalleryExampleInput): GalleryExampleInput {
  return {
    ...base,
    id: "ridgeline-published",
    status: "published",
    cost: { balanceBeforeCredits: 4000, balanceAfterCredits: 3850, credits: 150, usd: 0.71, measuredOn: "2026-11-12", verificationRow: "docs/VERIFICATION.md, 2026-11-12 10:00" },
    outputs: [
      { kind: "still", file: "frame.jpg", caption: "The approved frame", sha256: SHA, width: 1080, height: 1920 },
      { kind: "export", file: "ad.mp4", caption: "The Quick Ad <with captions>", sha256: SHA, width: 1080, height: 1920, durationSeconds: 4 },
    ],
    flaws: ["The cap reads slightly lighter than the product photo."],
  };
}

describe("gallery schema", () => {
  test("the shipped examples all pass; the one draft has no outputs or cost and uses only the invented persona", async () => {
    const { examples, problems } = await loadGallery(EXAMPLES);
    assert.deepEqual(problems, []);
    assert.ok(examples.length >= 1);
    const draft = await shippedDraft();
    assert.equal(draft.status, "draft");
    assert.equal(draft.cost, null);
    assert.deepEqual(draft.outputs, []);
    assert.equal(exampleStatusLabel({ status: "draft" }), "Not yet generated");
    assert.deepEqual(exampleLibraryItems(GalleryExampleSchema.parse(draft)).map((item) => item.name), ["Avery Lane", "Ridgeline 32 oz insulated bottle", "Bright kitchen counter"]);
  });

  test("drafts cannot carry outputs or cost; published examples need the cost from the balance, an export, and flaws", async () => {
    const draft = await shippedDraft();
    const full = published(draft);
    assert.ok(GalleryExampleSchema.safeParse(full).success);
    const issues = (input: unknown) => {
      const parsed = GalleryExampleSchema.safeParse(input);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    assert.match(issues({ ...draft, outputs: full.outputs }).join(), /A draft has no outputs/);
    assert.match(issues({ ...draft, cost: full.cost }).join(), /no settled cost/);
    assert.match(issues({ ...full, cost: null }).join(), /balance before and after/);
    assert.match(issues({ ...full, outputs: full.outputs!.slice(0, 1) }).join(), /includes its export/);
    assert.match(issues({ ...full, flaws: [] }).join(), /lists its flaws/);
    assert.match(issues({ ...full, cost: { ...full.cost!, credits: 120 } }).join(), /balance before minus the balance after/);
    assert.match(issues({ ...full, outputs: [{ ...full.outputs![1], file: "../../secrets.json" }] }).join(), /example's folder/);
    assert.match(issues({ ...full, outputs: [full.outputs![1], full.outputs![1]] }).join(), /each output file once/);
  });

  test("an example becomes an inbound context with this Library's ids", async () => {
    const draft = GalleryExampleSchema.parse(await shippedDraft());
    const ids = { "character:avery-lane": "c1", "product:ridgeline-32": "p1", "set:kitchen-counter": "s1" };
    assert.deepEqual(exampleInbound(draft, ids), {
      brief: draft.brief,
      libraryRefs: [
        { kind: "character", id: "c1" },
        { kind: "product", id: "p1" },
        { kind: "set", id: "s1" },
      ],
      source: { kind: "gallery", ref: "ridgeline-quick-ad" },
    });
    assert.throws(() => exampleInbound(draft, {}), /No Library character for avery-lane/);
  });
});

describe("gallery loader and site", () => {
  const dir = mkdtempSync(join(tmpdir(), "creator-lab-gallery-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a broken folder is reported with its first problem, never hidden", async () => {
    const draft = await shippedDraft();
    const write = (folder: string, body: unknown) => {
      mkdirSync(join(dir, folder), { recursive: true });
      writeFileSync(join(dir, folder, "example.json"), typeof body === "string" ? body : JSON.stringify(body));
    };
    write("ridgeline-quick-ad", draft);
    write("not-json", "{");
    write("wrong-name", { ...draft, id: "something-else" });
    write("ridgeline-published", published(draft));
    const { examples, problems } = await loadGallery(dir);
    assert.deepEqual(examples.map((example) => example.id), ["ridgeline-quick-ad"]);
    assert.deepEqual(
      problems.map((problem) => problem.folder),
      ["not-json", "ridgeline-published", "wrong-name"],
    );
    assert.match(problems.find((problem) => problem.folder === "ridgeline-published")!.message, /frame\.jpg is not in the folder/);
    writeFileSync(join(dir, "ridgeline-published", "frame.jpg"), "x");
    writeFileSync(join(dir, "ridgeline-published", "ad.mp4"), "x");
    const again = await loadGallery(dir);
    assert.deepEqual(again.examples.map((example) => example.status), ["published", "draft"], "published first");
  });

  test("the site shows a draft as not yet generated with no media, and a published example with its outputs, cost, and flaws", async () => {
    const draft = GalleryExampleSchema.parse(await shippedDraft());
    const full = GalleryExampleSchema.parse(published(draft));
    const draftPage = renderExamplePage(draft);
    assert.match(draftPage, /Not yet generated/);
    assert.doesNotMatch(draftPage, /<video|<img/);
    assert.match(draftPage, /router-nano-banana-pro-t2i/);
    const page = renderExamplePage(full);
    assert.match(page, /<video src="files\/ad\.mp4"/);
    assert.match(page, /150 credits \(0\.71 USD\), settled from the balance \(4000 before, 3850 after\)/);
    assert.match(page, /The cap reads slightly lighter/);
    assert.match(page, /The Quick Ad &lt;with captions&gt;/, "captions are escaped");
    assert.equal(escapeHtml(`<a href="x">'`), "&lt;a href=&quot;x&quot;&gt;&#39;");
    const site = renderGallerySite([full, draft], { repoUrl: "https://example.com/repo" });
    assert.deepEqual(site.pages.map((entry) => entry.path), ["index.html", "examples/ridgeline-published/index.html", "examples/ridgeline-quick-ad/index.html"]);
    assert.deepEqual(site.copies.map((copy) => copy.to), ["examples/ridgeline-published/files/frame.jpg", "examples/ridgeline-published/files/ad.mp4"]);
    assert.match(site.pages[0].html, /Not yet generated/);
    assert.match(site.pages[0].html, /<a href="https:\/\/example\.com\/repo">AI Creator Lab<\/a>/);
    assert.doesNotMatch(renderGallerySite([draft], { repoUrl: "javascript:alert(1)" }).pages[0].html, /javascript:/);
  });
});

describe("gallery routes: start from this example", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "creator-lab-gallery-api-"));
  const savedEnv = { ...process.env };
  let routes: {
    gallery: typeof import("@/app/api/gallery/route");
    start: typeof import("@/app/api/gallery/[id]/start/route");
    file: typeof import("@/app/api/gallery/[id]/files/[name]/route");
    projects: typeof import("@/app/api/projects/route");
    project: typeof import("@/app/api/projects/[id]/route");
    library: typeof import("@/app/api/library/route");
    runtime: typeof import("@/server/runtime");
  };
  const post = (path: string, body: unknown) => new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const params = <T>(value: T) => ({ params: Promise.resolve(value) });

  before(async () => {
    process.env.STUDIO_DATA_DIR = dataDir;
    delete process.env.STUDIO_EXAMPLES_DIR;
    routes = {
      gallery: await import("@/app/api/gallery/route"),
      start: await import("@/app/api/gallery/[id]/start/route"),
      file: await import("@/app/api/gallery/[id]/files/[name]/route"),
      projects: await import("@/app/api/projects/route"),
      project: await import("@/app/api/projects/[id]/route"),
      library: await import("@/app/api/library/route"),
      runtime: await import("@/server/runtime"),
    };
  });
  after(() => {
    routes?.runtime.closeStore();
    process.env = savedEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("lists the draft as not yet generated, seeds a project from it, and reuses the Library items the second time", async () => {
    const listed = (await (await routes.gallery.GET()).json()) as { examples: { id: string; statusLabel: string; outputs: unknown[] }[]; problems: unknown[] };
    assert.deepEqual(listed.problems, []);
    const draft = listed.examples.find((example) => example.id === "ridgeline-quick-ad");
    assert.ok(draft);
    assert.equal(draft.statusLabel, "Not yet generated");

    const startOnce = async () => {
      const prepared = await routes.start.POST(post("/api/gallery/ridgeline-quick-ad/start", {}), params({ id: "ridgeline-quick-ad" }));
      assert.equal(prepared.status, 200);
      const body = (await prepared.json()) as { name: string; appId: string; inbound: { libraryRefs: { kind: string; id: string }[] }; panel: string | null; created: string[]; reused: string[] };
      const created = await routes.projects.POST(post("/api/projects", { name: body.name, appId: body.appId, inbound: body.inbound }));
      assert.equal(created.status, 201);
      const project = (await created.json()) as { project: { id: string; brief: { productSummary: string }; origin: { kind: string; ref: string } }; links: { itemId: string }[] };
      return { body, project };
    };
    const first = await startOnce();
    assert.equal(first.body.panel, "ugc-ad.quick", "a Quick Ad example opens on the Quick Ad tab");
    assert.equal(first.body.created.length, 3);
    assert.deepEqual(first.project.project.origin, { kind: "gallery", ref: "ridgeline-quick-ad" });
    assert.equal(first.project.project.brief.productSummary, "Ridgeline 32 oz insulated bottle, keeps drinks cold 24 hours");
    assert.deepEqual(first.project.links.map((link) => link.itemId), first.body.inbound.libraryRefs.map((ref) => ref.id));

    const second = await startOnce();
    assert.deepEqual(second.body.created, []);
    assert.deepEqual(second.body.reused.sort(), first.body.created.sort(), "the same Library items, not copies");
    const library = (await (await routes.library.GET(new Request("http://localhost:3000/api/library"))).json()) as { items: unknown[] };
    assert.equal(library.items.length, 3);
  });

  test("an unknown example or a file the example does not list is a 404", async () => {
    assert.equal((await routes.start.POST(post("/api/gallery/nope/start", {}), params({ id: "nope" }))).status, 404);
    assert.equal((await routes.start.POST(post("/api/gallery/..%2F/start", {}), params({ id: "../" }))).status, 404);
    const file = await routes.file.GET(new Request("http://localhost:3000/api/gallery/ridgeline-quick-ad/files/ad.mp4"), params({ id: "ridgeline-quick-ad", name: "ad.mp4" }));
    assert.equal(file.status, 404);
    const escape = await routes.file.GET(new Request("http://localhost:3000/x"), params({ id: "ridgeline-quick-ad", name: "../example.json" }));
    assert.equal(escape.status, 404);
  });
});
