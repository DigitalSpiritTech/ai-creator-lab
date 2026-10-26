# Working agreements

Read `docs/PLAN.md` before changing scope and `docs/TASKS.md` before starting work. The current phase is the competition MVP of the UGC Creator app running on Comfy Cloud, Comfy API, and Comfy Router.

## Stack

Next.js 16 App Router, React 19, TypeScript, Tailwind 4 with shadcn/ui, Node 22 or newer with the built-in `node:sqlite` module, Zod 4 for every boundary contract, `@comfyorg/sdk` for Comfy Cloud, API deployments, and the local proxy, direct HTTP for Comfy Router, the Anthropic SDK for the assistant, ffmpeg and ffprobe on the host. Single user, loopback by default.

## Code conventions

- Normal formatting: Prettier defaults, one statement per line, no 300-character lines.
- TSDoc on modules and exported functions where the intent is not obvious from the name and types. No doc comments on inline callbacks or trivial helpers.
- Zod schemas are the source of truth at boundaries: HTTP bodies and responses, SQLite JSON columns, provider responses, LLM tool inputs and outputs. Derive TypeScript types from them.
- Prefer small pure functions, immutable updates, discriminated unions for states. Side effects live in `src/server/`. Server-only modules import `server-only`.
- Plain async by default. Effect is allowed where ported code already uses it for resource scoping; do not introduce it elsewhere.
- Tests use `node:test` through `tsx`. Every executor has offline tests with fixtures. Domain state transitions have unit tests. One HTTP acceptance smoke covers the whole flow with the mock executor.
- Names: Library, Archive, Project, Asset, Recipe, Capability, Shot, Beat, Content piece. See `docs/PRODUCT.md`. Do not reintroduce "elements", "scenes", or "takes" in user-facing text.

## Safety rules

- Paid generation runs only when `GENERATION_ALLOWANCE_USD` in `.env.local` is above zero. Agents never create, edit, or suggest values for that variable; the maintainer sets it. Every real provider run is logged in `docs/VERIFICATION.md`.
- Comfy credits are the real budget. Cloud workflow runs and Router calls both draw from the same credit balance; the ledger converts at 210 credits per USD (the observed Router rate, matching the Base plan's monthly rate), so a $5 allowance is about 1,050 credits for the entire build, spike included. Before and after every real run, read the account's credit balance, log the delta and the running total in `docs/VERIFICATION.md`, post a note at 50 percent and 80 percent of the cap, and stop submitting at 100 percent until the maintainer raises the allowance. Never spend the whole balance because it is there.
- Never commit `.env.local`, `.data/`, keys, or media from real runs. Keys are read on the server only and never appear in client bundles, API responses, logs, or error messages.
- Privacy: no private character names, private reference images, or private project details anywhere in this repository, including tests, fixtures, screenshots, and commit messages. Use the invented example persona in `docs/PRODUCT.md`.
- Porting from `../open-higgs` (the previous project folder beside this one, read-only reference) is allowed only for the files listed in `docs/PLAN.md`. Port code, reformat it, drop removed features. Never copy its documentation prose or screenshots.
- Content stays SFW. Body references use athleticwear.

## Definition of done

`npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass. New behavior has a test, or a manual check recorded in `docs/VERIFICATION.md` when it needs a real account. User-facing changes update the README or `docs/`. No TODO comments without a matching entry in `docs/TASKS.md`. Commit messages say what changed and why in one line, with details below if needed.
