# Deploying a read-only demo

AI Creator Lab is meant to run on your own computer. This page is for the one other way to run it: a public, read-only copy that lets people look at finished projects without being able to change, upload, or generate anything. The competition "try it" link runs this way.

## What read-only mode does

With `STUDIO_READ_ONLY=1`:

- Every request that could change something (any method other than GET, HEAD or OPTIONS) is refused before it reaches a route, with a message that says it is a demo.
- The chat box is switched off and a banner across the top says the demo is read-only, with a link to the repository.
- `STUDIO_PUBLIC_HOST` names the one hostname the local-only guard accepts besides localhost, so the app can sit behind a platform proxy without rewriting headers. The variable does nothing unless read-only mode is on.
- The Docker image refuses to start unless both are set, and refuses to start at all if `COMFY_API_KEY`, `ANTHROPIC_API_KEY` or `GENERATION_ALLOWANCE_USD` is present. It also deletes any `secrets.json` in the data folder on start. A demo server never holds keys, so even a bug in the guard could not spend anything.

Keep the startup recovery off (`STUDIO_RECOVERY=off`, set in the image) so the server does not try to resume old jobs.

## What to put in the data folder

A copy of a data folder from a finished run, with `secrets.json` removed: `studio.sqlite`, `media/`, `references/`, `exports/`. Make it on your own machine first (export the ad, check every project you leave in it is something you want public), then upload it. Delete `export-work/` and `catalog/` from the copy; they are scratch.

## Fly.io

Once, from the repo folder, with the Fly CLI signed in:

```
fly launch --copy-config --no-deploy
fly volumes create demo_data --size 1 --region dfw
fly deploy
```

`fly launch` reads `fly.toml` (app name, region, the `/data` volume, the read-only variables). Change `app` and `primary_region` there if you like, and set `STUDIO_PUBLIC_HOST` to the hostname you will serve: the default is the Fly hostname `<app>.fly.dev`; for your own domain, `fly certs add demo.example.com`, point a CNAME at `<app>.fly.dev`, and change the variable to match.

Then upload the data folder to the volume:

```
fly ssh sftp shell
put -r /path/to/your/demo-data /data
```

(or `fly ssh console` and `tar` over `fly ssh sftp`). Restart with `fly apps restart <app>` and open the hostname. The Projects page should list your demo projects with the banner on top; a POST from the browser's devtools should answer 403 with the demo message.

The app sleeps when idle (`auto_stop_machines = "stop"`) and wakes on the first request, so a shared-cpu-1x machine with 512 MB and a 1 GB volume costs a few dollars a month.

## Anywhere else

The image works on any Docker host: mount a folder at `/data`, pass `STUDIO_READ_ONLY=1` and `STUDIO_PUBLIC_HOST`, put a TLS proxy in front that forwards the `Host` header as the browser sent it and sets `X-Forwarded-Proto: https`, and publish port 3000 only to that proxy.
