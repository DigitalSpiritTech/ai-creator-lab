# Post drafts

Placeholders in angle brackets are filled in before posting. Plain text, ready to paste.

## Submission post

Hashtag: #OpenSourceHiggsfield

```
I built AI Creator Lab for the #OpenSourceHiggsfield challenge: an open-source studio that takes a creator from "here's my product" to a finished 1080x1920 ad, running on your own Comfy account.

A built-in assistant walks you through the brief, a character bible, a locked face, a body reference, a project reference sheet, the product card, a script, one start frame per beat, one LTX clip per beat, and the final assembly with captions. Everything you approve goes into a Library you can reuse. It supports Comfy Cloud workflows (Z-Image, Qwen Image Edit, LTX 2.5) and hosted models through Comfy Router.

Honest status: it is early and single-user. One content type (Ad) works end to end; a complete three-beat ad cost about 60 credits when I tested it on October 26. Microdramas and organic posts are not built yet, and the workflows have only been verified on Comfy Cloud.

Demo (2 min): <demo link>
Code (MIT): <repository link>
```

## Build-in-public thread

Six short posts. Post them in order as a thread.

```
1/6
I'm building an open-source alternative to closed AI creator platforms: AI Creator Lab. You bring your own Comfy account, it runs the whole flow from product to finished vertical ad. Here's what I built and what I learned. <repository link>

2/6
The flow: brief, character bible, face lock, body reference, a per-project reference sheet, product card, script, a start frame per beat, an LTX clip per beat, then assembly into a 1080x1920 MP4 with captions. Every approved thing goes into a reusable Library.

3/6
Design choice that paid off: no "only" model. Each step asks for a capability (text to image, image edit, image to video) and any recipe can fill it, either a hosted model or a ComfyUI workflow with a small sidecar file that maps the prompt, images, and seed. Swapping models is a file, not a rewrite.

4/6
The money part. A complete three-beat ad cost about 60 credits on Comfy Cloud: roughly 2 to 3 per still, 7 to 14 per composition, about 10 per LTX clip. Spending is capped by an allowance that defaults to zero, and every real run is logged with the balance before and after.

5/6
Things that bit me: the image model ignored "three-quarter view" until I stated the head turn explicitly. It printed the product name on the bottle and once added a second bottle. LTX needs an exact 576x1024 input, so the app crops and scales first. Cloud's job status says "succeeded", not "completed".

6/6
What's next: a Microdrama app, organic post content, and an MCP server so Claude Code can drive the same tools. It's MIT licensed and early, so issues and pull requests are welcome. Code: <repository link> Demo: <demo link>
```
