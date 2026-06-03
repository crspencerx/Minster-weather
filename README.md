# Minster Round Weather v4

A mobile-first rain dashboard for window-cleaning rounds in Minster-in-Thanet.

## What works immediately

- Open-Meteo three-day forecast with a 15-minute working timeline.
- 09:00–13:00 main-round planning and a 13:00–17:00 recovery-slot recommendation.
- Animated Rain Viewer observed-radar map centred on Minster.
- Editable rain thresholds.

## Advanced features included in v4

The website is ready to connect to a private Cloudflare Worker proxy. Once connected, it adds:

- Rainbow Weather minute-by-minute precipitation nowcasting for the next four hours.
- Estimated rain arrival time, duration, and peak intensity.
- Met Office Weather DataHub Global Spot hourly data as a second opinion.
- A confidence card showing whether Open-Meteo and the Met Office broadly agree.

The proxy is important: never put either provider's API key into public GitHub Pages files.

## Update the GitHub Pages site

Upload the files from this `minster-weather` folder into the root of your existing GitHub repository and commit the changes. The standard dashboard will continue to work before the proxy is connected.

## Connect the advanced feeds

### 1. Obtain the two API keys

- Create a Rainbow Weather developer account and obtain an API token.
- Register with Met Office Weather DataHub, subscribe to the free Site-Specific Global Spot plan, and obtain an API key.

### 2. Create a Cloudflare Worker

Create a new Cloudflare Worker using the code in `worker/worker.js`.

Add these secrets in the Worker's settings:

- `RAINBOW_API_TOKEN`
- `METOFFICE_API_KEY`

Add this ordinary environment variable:

- `ALLOWED_ORIGIN` = `https://crspencerx.github.io`

Deploy the Worker and copy its address, such as `https://minster-weather-proxy.example.workers.dev`.

### 3. Paste the Worker address into the dashboard

Open the dashboard, tap **Rain rules**, paste the Worker address into **Private weather proxy address**, and save.

The address is saved on your phone. API keys remain private inside Cloudflare.

## Notes

- Forecasts remain uncertain. The dashboard is a work-planning aid, not a guarantee for an individual property.
- The advanced feeds degrade gracefully: Open-Meteo and the Rain Viewer observed-radar map remain available if either additional feed fails.
- The Met Office response normaliser is written defensively around its GeoJSON time-series response. If the provider changes field names, the Worker may need a small adjustment.
