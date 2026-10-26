---
name: verify-release
description: Checks to run before any commit and before release: typecheck, lint, tests, build, acceptance smoke, fresh install, privacy and secret scans, and the competition packet. Use as qa-reviewer or before reporting any task done.
---

# Verify before commit and release

## Before every commit

```sh
npm run typecheck && npm run lint && npm test && npm run build
```

Then the privacy and secret scan (must print nothing):

```sh
git grep -n -i -E '\b(dana|mara|kowalski|noctelle|shop b|gx10)\b' -- . ':!node_modules' ':!.data' ':!.claude/skills/verify-release/SKILL.md'
git grep -n -E 'comfyui-[A-Za-z0-9]{12,}|sk-ant-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{32,}' -- . ':!node_modules' ':!.data' ':!.claude/skills/verify-release/SKILL.md'
git status --porcelain | grep -E '\.env|\.data/|\.sqlite' 
```

Confirm `.gitignore` covers `.env*` (except `.env.example`), `.data/`, `*.sqlite*`, `.next/`, `node_modules/`.

## Before release

1. Fresh install: clone or unzip into an empty directory, `npm ci`, run the four commands, `npm run build && npm start`, create a project with the mock executor, run brief to assembly, restart, confirm the project is still there. Record it in `docs/VERIFICATION.md`.
2. Real run: one complete ad on real accounts with the invented persona, recorded with cost and durations.
3. README: setup works as written on a machine without the repo's history; pricing numbers are dated; the maintainer section is present; no private names; license and third-party notices present (MIT for the app, shadcn attribution, font license, LTX and Comfy credits).
4. `workflows/README.md` lists every workflow with its verification date.
5. Competition packet: public repository link, license visible, demo under two minutes, social post with the required hashtag linking the demo, form answers drafted. Recheck the official page for any requirement changes on submission day.

## Reporting

Findings ranked by severity: blocker (breaks the end-to-end path, leaks a key or private name, spends credits without allowance), major (wrong behavior with a workaround), minor (polish). Each finding has the file, the reproduction, and the suggested fix. Say what was verified, not just what was read.
