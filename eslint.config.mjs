import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const APP_ALIAS = { group: ["@/*", "@creator-lab/app-creator", "@creator-lab/app-creator/*"], message: "Packages never import the app; the app imports them." };

/**
 * The package dependency direction, enforced: core <- recipes <- executors <- app, ui and content
 * plugins on core only. A package imports another only through its name, never `@/` or a path.
 */
function restrict(allowed) {
  const all = ["core", "recipes", "executors", "ui", "content-ugc-ad"];
  const denied = all.filter((name) => !allowed.includes(name)).flatMap((name) => [`@creator-lab/${name}`, `@creator-lab/${name}/*`]);
  return {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          APP_ALIAS,
          ...(denied.length ? [{ group: denied, message: "This package may not depend on that one (see CONTRIBUTING.md, Where code lives)." }] : []),
          { group: ["../../*/src/*", "../../../packages/*"], message: "Import another package by its name." },
        ],
      },
    ],
  };
}

/** Applies Next.js and TypeScript lint checks; no inputs or expected errors. */
export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  { settings: { next: { rootDir: "apps/creator/" } } },
  { files: ["packages/core/**/*.{ts,tsx}"], rules: restrict([]) },
  { files: ["packages/recipes/**/*.{ts,tsx}"], rules: restrict(["core"]) },
  { files: ["packages/executors/**/*.{ts,tsx}"], rules: restrict(["core", "recipes"]) },
  { files: ["packages/ui/**/*.{ts,tsx}"], rules: restrict(["core"]) },
  { files: ["packages/content-*/**/*.{ts,tsx}"], rules: restrict(["core", "ui"]) },
  globalIgnores([".next/**", "**/.next/**", "next-env.d.ts", "**/next-env.d.ts", ".data/**"]),
]);
