# Driving the studio from Claude Code (MCP)

The studio ships an MCP server over the same tools the in-app assistant uses, so Claude Code (or Claude Desktop, or any MCP client) can make an ad with you from a terminal. This page has the setup, the two permission flags, and a sample Quick Ad session. The README's "MCP server" section has the same setup in brief.

## Setup

The server is a stdio process started from the clone: `npm run --silent mcp` (the `--silent` matters: npm's banner on stdout would break the protocol). It opens the same data folder as the app (`STUDIO_DATA_DIR`, default `.data` in the clone), so projects you make over MCP show up in the app and the other way round. Keys come from `.env.local` (loaded when present) or from the `secrets.json` Settings writes in the data folder. The app does not need to be running.

The repository does not ship a `.mcp.json`. To add the server for your clone only, create `.mcp.json` in the clone's root (Claude Code reads it when you start `claude` there, and asks you to approve the server the first time). This one allows spending; leave out the `env` block for a server that can only propose:

```json
{
  "mcpServers": {
    "ai-creator-lab": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "env": {
        "MCP_ALLOW_SPEND": "1"
      }
    }
  }
}
```

Or add it from the command line, in the clone:

```sh
claude mcp add ai-creator-lab -e MCP_ALLOW_SPEND=1 -- npm run --silent mcp
```

Leave out `MCP_ALLOW_SPEND` to start with a server that can only propose (below). Claude Desktop does not start in the clone, so give it the folder: `"args": ["--prefix", "/path/to/ai-creator-lab", "run", "--silent", "mcp"]` and `"env": { "STUDIO_DATA_DIR": "/path/to/ai-creator-lab/.data" }`.

## The two flags

An MCP client has no proposal card to click, so the two actions that cannot be undone are off unless the person starting the server turns them on.

| Flag | Off (default) | On (`=1`) |
| --- | --- | --- |
| `MCP_ALLOW_SPEND` | `approve_and_generate` is not offered and not callable. Generation tools (`compose_still`, `generate_clip`, `propose_candidates`, `start_quick_ad`'s next steps) still return proposals with the recipe, prompt, and estimated cost; you run them from the app, where each waits for your click. | `approve_and_generate` is offered. It is the spending gate: the client should call it only after you have read a proposal and said yes. It is held to the same monthly budget as the app, capped by `GENERATION_ALLOWANCE_USD` (zero blocks every paid run). It cannot add to a month; only a click in the app does that. Submitting the same proposal twice never runs it twice. |
| `MCP_ALLOW_DELETE` | `delete_asset_everywhere` is not offered. `archive_asset` (restorable from the Archive page) is. | `delete_asset_everywhere` is offered: it removes a file for good and breaks every reference to it. Keep it off unless you are cleaning up on purpose. |

The other tools are always offered: every roster tool (34 core tools, including `start_quick_ad`) and the installed plugins' tools, under their own names. Two resources let the client look at the work: `project://{id}/state` (the whole project as JSON) and `asset://{id}` (a candidate's file).

## Sample session: a Quick Ad

With `MCP_ALLOW_SPEND=1`, from the clone. What you type is quoted; the tool calls are what Claude Code runs. The ids are shortened here.

> "Make a Quick Ad in a new project called Ridgeline quick: Ridgeline 32 oz insulated bottle, keeps drinks cold 24 hours, for commuters who leave a drink in the car, on TikTok."

There is no project-creation tool over MCP; projects are made in the app (Projects, Quick Ad) or with `POST /api/projects` on a running app. So first create the project in the app and give Claude its id from the address bar, or ask it to use an existing one: the server lists every project as a `project://{id}/state` resource (the MCP resources list, which Claude Code can read), and reading one returns that project's state.

1. `start_quick_ad` with `projectId` and the two lines as `brief.productSummary` and `brief.audience`. It saves the brief, a one-beat four-second talking script (the spoken line and caption from the first line), and the Ad in quick mode, and returns `contentId` and the plan: a frame (`text_to_image` with nothing in the Library, `image_edit` with a linked character or product photo) and an `image_to_video` clip, one candidate each. Nothing has spent.
2. `compose_still` with `contentId` and `beatIndex: 1`. It returns a proposal: recipe, prompt, one candidate, estimate. Claude shows it to you and stops.

   > "Go ahead."

3. `approve_and_generate` with that proposal and `wait: true`. The frame is made and lands on the beat. Claude can read it as `asset://{id}`; you can look at it in the app's Quick Ad tab.

   > "Approve that frame."

4. `approve` with `kind: "still"`, `contentId`, `beatIndex: 1`, and the asset id. Approval 1 of 3.
5. `generate_clip` with `contentId` and `beatIndex: 1`: a proposal for one four-second clip with the line spoken. After your yes, `approve_and_generate`, then after you have watched it, `approve` with `kind: "clip"`. Approval 2 of 3.

   > "Export it."

6. `assemble_ad` with `contentId` (captions on by default). Approval 3 of 3. It returns the export record and the MP4 asset, 1080 x 1920 with the caption burned in; it is on the Assets page and in the Quick Ad tab.

Without `MCP_ALLOW_SPEND`, steps 3 and 5 are yours in the app: the proposals Claude made are not submitted, so open the project, press Compose the frame or Make the clip in the Quick Ad tab, and approve the card. Everything else in the session is the same.

The offline test `tests/mcp-server.test.ts` runs this exact sequence against the mock executor.

## Rules the server keeps

- Every call goes through the same tool layer as the app (`callTool`): inputs are checked with Zod, and failures come back as `{ code, message }` with `isError`.
- The server log (stderr) has one line per call, the tool name and outcome, never inputs or keys.
- Raising the monthly budget or the operator ceiling is not a tool. A run that would cross the budget comes back blocked with the spent, remaining, and cost figures.
