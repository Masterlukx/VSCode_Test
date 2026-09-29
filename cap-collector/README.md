# Cap Collector

A phone web app (PWA) for managing a bottle-cap collection. Scan a cap and it tells you whether you already have it; if you don't, it adds the cap to your collection.

## Workflow
1. Hold the cap inside the dashed circle and tap the shutter. You can also pick an existing photo and drag or pinch it into the circle.
2. The app compares the photo with every cap you already have. Rotation doesn't matter.
3. **No match:** the cap is added right away. You can add a label, or undo if it turns out you already had it.
4. **Likely match:** the app shows the closest lookalikes side by side, and you decide whether it's the same cap (discard) or a new one (add).

Everything stays on the phone (IndexedDB), and the app works offline. Use *Collection → Settings & backup* to export or import a backup file.

## Getting it onto the Pixel
The camera only works on a page served over **HTTPS**, so the folder has to be hosted. The easiest free option is GitHub Pages:

1. Create a public GitHub repo and upload the contents of this folder.
2. In the repo, go to *Settings → Pages → Deploy from branch → main / root*.
3. On the phone, open `https://<user>.github.io/<repo>/` in Chrome.
4. Open the ⋮ menu, choose **Add to Home screen / Install app**, and allow camera access.

## How the matching works
Each cap gets a fingerprint made of:
- A polar "unwrap" of the cap's brightness pattern. A rotated cap is just a shifted unwrap, so all 64 rotations are compared.
- A hue/saturation colour histogram.

A fast pre-filter picks the 60 best candidates, and the full rotation-aware comparison then scores them. You can adjust the duplicate threshold (default 72%) in Settings.

**Tips for good results:** shoot with even light and no strong glare (the 🔦 button toggles the flashlight), and fill the circle the same way each time.
