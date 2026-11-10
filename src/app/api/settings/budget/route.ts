/**
 * "Add to this month": raises the current budget period only, up to the operator ceiling. The next
 * period starts from the monthly budget again. This is a person's click in Settings or on the
 * approve step's budget dialog; it is deliberately not a tool, so neither the assistant nor the MCP
 * server can raise the budget. Repeating a request id adds the money once.
 * @packageDocumentation
 */
import { ExtendBudgetRequestSchema } from "@/lib/domain/spend";
import { addBudgetExtension } from "@/server/executors/spend";
import { readJson } from "@/server/http";
import { settingsView } from "@/app/api/_lib/settings";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const body = ExtendBudgetRequestSchema.parse(await readJson(request));
    return withStore((store) => {
      const { created } = addBudgetExtension({ store }, body);
      return Response.json({ ...settingsView(store), created }, { status: created ? 201 : 200 });
    });
  });
}
