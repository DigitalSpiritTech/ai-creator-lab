#!/usr/bin/env node
/**
 * Runs after `next build` in `npm run build`: records the commit `.next` was built from, so
 * `npx ai-creator-lab` starts that build without rebuilding it.
 */
import { fileURLToPath } from "node:url";
import { writeBuildStamp } from "./launch-config.mjs";

writeBuildStamp(fileURLToPath(new URL("../../../", import.meta.url)));
