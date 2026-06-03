# Minster Round Weather

A mobile-first rain dashboard for window-cleaning rounds in Minster-in-Thanet.

## What it does

- Fetches a three-day forecast from Open-Meteo without an API key.
- Shows a practical 12-hour working timeline in 15-minute blocks.
- Scores the usual 09:00–13:00 round and the 13:00–17:00 recovery slot.
- Recommends whether no afternoon cover, one-person cover, or two-person cover is worth keeping available.
- Uses hourly rain probability to flag shower-risk periods even when rainfall totals are low.
- Flags prolonged heavier rain using editable thresholds.
- Displays an animated Rain Viewer radar overlay centred on Minster.
- Clearly distinguishes observed radar frames from future forecast data.
- Can be installed to a phone home screen when hosted over HTTPS.

## Run it locally

From this folder, start a tiny static web server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser.

Opening `index.html` directly may also work, but a local web server is better and is required for installable PWA behaviour.

## Put it online free

The simplest approach is GitHub Pages:

1. Create a new GitHub repository.
2. Upload all files from this folder.
3. In the repository settings, open **Pages**.
4. Deploy from the `main` branch and root folder.
5. Open the HTTPS address on your phone and choose **Add to Home screen**.

## Current limitations

- Rain Viewer public radar frames are observations from the previous two hours, not future radar predictions.
- Open-Meteo 15-minute rainfall values may be interpolated in regions without native high-resolution 15-minute model data.
- Forecast and radar feeds are useful decision aids, not guarantees for an individual property.
- This starter version uses free endpoints for evaluation and personal use. Check commercial licensing before publishing it as a public business service.
