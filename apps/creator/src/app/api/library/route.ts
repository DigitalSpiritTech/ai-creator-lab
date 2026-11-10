/**
 * Lists Library items (characters, products, sets) with their project links.
 * @packageDocumentation
 */
import { z } from "zod";
import { parseQuery, route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  kind: z.enum(["character", "product", "set"]).optional(),
  archived: z.enum(["true", "false"]).default("false"),
});

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const query = parseQuery(request, QuerySchema);
    return withStore((store) => {
      const items = store.library.list({ kind: query.kind, includeArchived: query.archived === "true" });
      const ids = new Set(items.map((item) => item.id));
      const links = store.library.listAllLinks().filter((link) => ids.has(link.itemId));
      const projects = store.projects.list().map(({ id, name }) => ({ id, name }));
      return Response.json({ items, links, projects });
    });
  });
}
