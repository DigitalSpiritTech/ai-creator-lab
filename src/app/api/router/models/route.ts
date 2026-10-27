/**
 * The Comfy Router model list for Settings: every model Router offers, which family adapter (if any)
 * the app has for it, the capabilities that adapter covers, and whether the user switched it on.
 * `?refresh=1` refetches the listing and the schemas of models without a cached one.
 * @packageDocumentation
 */
import { z } from "zod";
import { adapterFor } from "@/server/catalog/router-adapters";
import { RouterCatalog, createCatalogPort } from "@/server/catalog/router-catalog";
import { readSecrets } from "@/server/secrets";
import { parseQuery, route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({ refresh: z.enum(["1", "true"]).optional() });

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const query = parseQuery(request, QuerySchema);
    return withStore(async (store) => {
      const apiKey = readSecrets(store.dataDir).comfyApiKey;
      if (!apiKey) return Response.json({ error: "Add a Comfy API key in Settings to list Router models." }, { status: 409 });
      const catalog = new RouterCatalog({ port: createCatalogPort(apiKey), dataDir: store.dataDir });
      const models = await catalog.models({ refresh: !!query.refresh });
      const tagged = await catalog.tagged({ fetchSchemas: false });
      const tags = new Map(tagged.map((entry) => [entry.id, entry.tags]));
      const enabled = new Set(store.workspace.get().routerModels);
      return Response.json({
        fetchedAt: Date.now(),
        models: models.map((model) => {
          const adapter = adapterFor(model.id);
          const tag = tags.get(model.id) ?? null;
          return {
            id: model.id,
            provider: model.provider,
            model: model.model,
            family: adapter?.info.family ?? null,
            capabilities: adapter?.info.capabilities ?? tag?.capabilities ?? [],
            supported: !!adapter,
            enabled: enabled.has(model.id),
            note: adapter ? null : tag?.note ?? null,
          };
        }),
      });
    });
  });
}
