# Contributing

Thanks for helping with AI Creator Lab. Read `AGENTS.md` for the working agreements (stack, code conventions, safety rules, definition of done) before you change anything. This page covers branches, pull requests, and releases.

## Branches

The repository follows git-flow.

| Branch      | What lives there                                                                 | Who writes to it                                                                      |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `main`      | Released code only. Every commit on `main` is a tagged release.                  | Release merges from `develop` (or a `release/*` branch). Never commit to it directly. |
| `develop`   | The integration branch. Always builds and passes the tests.                      | Merges from `feature/*` and `fix/*` pull requests.                                    |
| `feature/*` | One piece of work, branched from `develop`.                                      | You.                                                                                  |
| `fix/*`     | A bug fix for `develop`, branched from `develop`.                                | You.                                                                                  |
| `release/*` | Optional. Final polish for a version (`release/0.2.0`), branched from `develop`. | The maintainer.                                                                       |
| `hotfix/*`  | A fix for a released version, branched from `main`.                              | The maintainer.                                                                       |

Name a branch after the task it does, short and lowercase: `feature/artifact-panel`, `fix/caption-clipping`. When the work comes from a numbered roadmap item, put the number first: `feature/03-artifact-panel`.

If you use the git-flow extension, `git flow init -d` picks these names (`main` for production, `develop` for the next release, `feature/`, `release/`, `hotfix/` prefixes, `v` as the version tag prefix). Plain git works just as well:

```sh
git fetch origin develop
git switch -c feature/my-change origin/develop
```

## Pull requests

1. Branch from the latest `develop`.
2. Keep one change per branch. Rebase on `develop` if it moves while you work (your own branch only; never rewrite `develop` or `main`).
3. Run the definition-of-done checks before you push:

   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```

   Run `npm run test:acceptance` too when you change routes, tools, storage, or assembly.

4. Open the pull request against `develop`, not `main`. Say what changed and why, list the tests you added, and note anything left unfinished.
5. A change that spends real Comfy credits needs a row in `docs/VERIFICATION.md`. Never commit `.env.local`, the data folder, keys, or media from real runs.

Merges into `develop` use a merge commit or squash, whichever keeps the history readable; the branch is deleted after merge.

## Releases

Releases are tagged on `main` only, with semantic versions and a `v` prefix (`v0.1.0`, `v0.2.0`). Tags are annotated and never moved or deleted once pushed; a mistake gets a new patch version.

1. Bring `develop` to a releasable state: all checks green, `README.md` and `docs/` current.
2. Optionally cut `release/X.Y.Z` from `develop` for last fixes, and set `"version"` in `package.json` to `X.Y.Z`.
3. Merge into `main` with a merge commit (no squash, so `main` and `develop` share history).
4. Tag the merge commit on `main`:

   ```sh
   git tag -a vX.Y.Z -m "AI Creator Lab X.Y.Z"
   git push origin vX.Y.Z
   ```

5. Merge `main` back into `develop` if the release branch carried fixes.
6. Write the release notes on GitHub from the tag.

A hotfix branches from `main` (`hotfix/X.Y.Z+1`), merges into both `main` and `develop`, and is tagged the same way.

## Versions

| Tag      | What it is                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `v0.1.0` | The Comfy "Open Source Higgsfield" competition submission (October 30, 2026). The submitted link points here, so it stays fixed. |
