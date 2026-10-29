# Example outputs

One complete run of the UGC Creator app on Comfy Cloud with the open-weights starter recipes, October 28, 2026. The creator, Avery Lane, and the product, the Ridgeline 32 oz insulated bottle, are invented. Nothing here is a real person or a real brand.

| File | Step | Recipe |
| --- | --- | --- |
| `01-face-reference.jpg` | Face lock, one of two candidates | Z-Image Turbo, text to image |
| `02-body-reference.jpg` | Body reference from the locked face | Qwen Image Edit 2511, one reference |
| `03-reference-sheet.jpg` | The project's reference sheet: portrait, front and back in the project wardrobe | Qwen Image Edit 2511, two references |
| `04-product.jpg` | Product photo | Qwen Image Edit 2511 |
| `05-still-beat-1.jpg` | Start frame for beat 1 (talking, in the car) | Qwen Image Edit 2511 from the sheet and the product |
| `06-still-beat-2.jpg` | Start frame for beat 2 (b-roll, the warm bottle) | Qwen Image Edit 2511 |
| `07-ridgeline-ad.mp4` | The finished 18 second ad: four LTX 2.5 clips with their own audio, two Chatterbox voice-overs over the b-roll, captions burned in, 1080 x 1920 | LTX 2.5 image to video, Chatterbox Turbo TTS, ffmpeg |

The whole run, including the candidates that were not picked, cost about 5 USD of Comfy credits across two attempts (one was a duplicate from a lookup slip); the ad itself is around 60 credits. The images are saved as JPEG at 1024 px on the long side for the repository; the app keeps the originals.
