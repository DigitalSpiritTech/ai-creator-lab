/**
 * Vocabulary in what a person reads: no "take" or "takes" in the UI's string literals and JSX text
 * (docs/PRODUCT.md; the maintainer's naming decision for F5 says "recording"). Code identifiers
 * such as `generate_take`, `take_cutaways`, and kind `"take"` stay, so a literal that is a single
 * identifier is allowed; comments are not read.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FOLDERS = ["apps/creator/src/components", "apps/creator/src/lib/client", "packages/ui/src", "packages/content-social-post/src/panels.tsx"];
const WORD = /\btakes?\b/i;
const IDENTIFIER = /^[A-Za-z_][\w-]*$/;

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (/\.tsx?$/.test(full)) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(full, entry.name)] : [],
  );
}

/** Every piece of literal text in a file: strings, template parts, and JSX text, with its line. */
function literals(path: string): { text: string; line: number }[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ text: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("UI text never says take or takes; code identifiers may", () => {
  const offending: string[] = [];
  const scanned = FOLDERS.flatMap(files);
  assert.ok(scanned.length > 20, "the UI folders were found");
  for (const path of scanned) {
    for (const { text, line } of literals(path)) {
      const trimmed = text.trim();
      if (!WORD.test(trimmed) || IDENTIFIER.test(trimmed)) continue;
      offending.push(`${relative(ROOT, path)}:${line}: ${JSON.stringify(trimmed.slice(0, 80))}`);
    }
  }
  assert.deepEqual(offending, [], `user-facing text says "take"; use "recording":\n${offending.join("\n")}`);
});

test("the check catches prose and lets identifiers through", () => {
  assert.equal(WORD.test("Another take") && !IDENTIFIER.test("Another take"), true);
  assert.equal(IDENTIFIER.test("take") && IDENTIFIER.test("take_cutaways"), true);
  assert.equal(WORD.test("generate_take"), false, "an underscore joins the identifier, so no word boundary");
});
