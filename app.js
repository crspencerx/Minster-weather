const LOCATION = { name: 'Minster-in-Thanet', lat: 51.3349, lon: 1.3147 };
const FORECAST_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LOCATION.lat}&longitude=${LOCATION.lon}&current=temperature_2m,precipitation,rain,showers,weather_code,wind_speed_10m&hourly=precipitation_probability,precipitation,rain,showers,weather_code,wind_speed_10m,wind_gusts_10m&minutely_15=precipitation,rain,showers&timezone=Europe%2FLondon&forecast_days=3`;
const RADAR_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const SETTINGS_KEY = 'minster-weather-rules-v1';

const defaultSettings = { cautionThreshold: 0.2, stopThreshold: 0.7, prolongedMinutes: 30 };
let settings = loadSettings();
let map;
let radarLayer;
let radarFrames = [];
let radarHost = '';
let radarFrameIndex = 0;
let radarTimer;
let forecastData;

function $(id) { return document.getElementById(id); }
function loadSettings() {
  try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...defaultSettings }; }
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function formatTime(date) { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date); }
function formatDay(date) { return new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(date); }
function formatDateTime(date) { return new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date); }
function parseLocal(value) { return new Date(value); }
function rainRateFrom15Min(value) { return Number(value || 0) * 4; }
function classForRate(rate) {
  if (rate >= settings.stopThreshold) return 'stop';
  if (rate >= settings.cautionThreshold) return 'caution';
  return 'dry';
}
function labelForClass(status) { return status === 'stop' ? 'Stop' : status === 'caution' ? 'Caution' : 'Workable'; }
function weatherEmoji(status) { return status === 'stop' ? '🌧️' : status === 'caution' ? '🌦️' : '🪟'; }
function roundUpToQuarter(date) { const d = new Date(date); d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15); return d; }

function showError(message) {
  let banner = document.querySelector('.error-banner');
  if (!banner) { banner = document.createElement('div'); banner.className = 'error-banner'; document.querySelector('main').prepend(banner); }
  banner.textContent = message;
}
function clearError() { document.querySelector('.error-banner')?.remove(); }

async function fetchForecast() {
  const response = await fetch(FORECAST_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Forecast request failed (${response.status})`);
  forecastData = await response.json();
  renderForecast(forecastData);
}

function buildQuarterHours(data) {
  const times = data.minutely_15.time.map(parseLocal);
  const precipitation = data.minutely_15.precipitation || [];
  const rain = data.minutely_15.rain || precipitation;
  const showers = data.minutely_15.showers || [];
  return times.map((time, index) => ({
    time,
    precipitation15: Number(precipitation[index] || 0),
    rain15: Number(rain[index] || 0),
    showers15: Number(showers[index] || 0),
    rate: rainRateFrom15Min(precipitation[index])
  }));
}

function findWetSpells(points) {
  const wet = points.map(point => ({ ...point, stopLike: point.rate >= settings.stopThreshold }));
  const spells = [];
  let current = null;
  wet.forEach((point) => {
    if (point.stopLike) {
      if (!current) current = { start: point.time, end: new Date(point.time.getTime() + 15 * 60000), maxRate: point.rate, blocks: 1 };
      else { current.end = new Date(point.time.getTime() + 15 * 60000); current.maxRate = Math.max(current.maxRate, point.rate); current.blocks += 1; }
    } else if (current) { spells.push(current); current = null; }
  });
  if (current) spells.push(current);
  return spells.filter(spell => spell.blocks * 15 >= settings.prolongedMinutes);
}

function renderForecast(data) {
  const points = buildQuarterHours(data);
  const now = new Date();
  const start = roundUpToQuarter(now);
  const upcoming = points.filter(point => point.time >= start).slice(0, 48);
  const nextTwoHours = upcoming.slice(0, 8);
  const spells = findWetSpells(points.filter(point => point.time >= start));
  const nextSpell = spells[0];
  const currentPrecipitation = Number(data.current.precipitation || 0);
  const currentIntervalSeconds = Number(data.current.interval || 900);
  const nowRate = currentPrecipitation * (3600 / currentIntervalSeconds);
  const immediateStatus = classForRate(nowRate);
  const twoHourHasStop = nextTwoHours.some(p => classForRate(p.rate) === 'stop');
  const twoHourHasCaution = nextTwoHours.some(p => classForRate(p.rate) === 'caution');
  const prolongedSoon = findWetSpells(nextTwoHours).length > 0;

  let overall = immediateStatus;
  if (overall === 'dry' && prolongedSoon) overall = 'stop';
  else if (overall === 'dry' && twoHourHasCaution) overall = 'caution';

  const statusCard = $('statusCard');
  statusCard.className = `status-card status-${overall}`;
  $('statusIcon').textContent = weatherEmoji(overall);
  const copy = {
    dry: ['Good to work', 'No meaningful rain is indicated over Minster right now. Check the radar before setting off if showers are nearby.'],
    caution: ['Use judgement', 'Light rain or shower risk is showing. The radar map below should help you judge whether it is passing or building.'],
    stop: ['Rain stop likely', 'A sustained or heavier wet period is showing. Avoid starting a fresh round until the highlighted spell has cleared.']
  }[overall];
  $('statusHeading').textContent = copy[0];
  $('statusSummary').textContent = copy[1];

  $('roundDecision').textContent = prolongedSoon || twoHourHasStop ? 'No — likely interruption' : twoHourHasCaution ? 'Maybe — check radar' : 'Yes — looks workable';
  $('nextStop').textContent = nextSpell ? `${formatTime(nextSpell.start)}–${formatTime(nextSpell.end)}` : 'None showing soon';
  $('updatedAt').textContent = `Forecast refreshed ${formatTime(new Date())} · Modelled current rain rate: ${nowRate.toFixed(1)} mm/hour`;
  renderTimeline(upcoming);
  renderDaily(data);
}

function renderTimeline(points) {
  const timeline = $('timeline');
  timeline.innerHTML = '';
  points.forEach((point, index) => {
    const status = classForRate(point.rate);
    const button = document.createElement('button');
    button.className = `timeline-block ${status}`;
    button.type = 'button';
    button.title = `${formatDateTime(point.time)} · ${point.rate.toFixed(1)} mm/hour · ${labelForClass(status)}`;
    button.dataset.hour = point.time.getMinutes() === 0 ? formatTime(point.time) : '';
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => {
      $('timelineDetail').textContent = `${formatDateTime(point.time)}: ${labelForClass(status)} · forecast rate ${point.rate.toFixed(1)} mm/hour (${point.precipitation15.toFixed(2)} mm during this 15-minute block).`;
    });
    timeline.appendChild(button);
  });
}

function renderDaily(data) {
  const dailyCards = $('dailyCards');
  dailyCards.innerHTML = '';
  const times = data.hourly.time.map(parseLocal);
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + dayOffset);
    const nextDay = new Date(day); nextDay.setDate(day.getDate() + 1);
    const rows = times.map((time, i) => ({ time, precip: Number(data.hourly.precipitation[i] || 0), probability: Number(data.hourly.precipitation_probability[i] || 0) }))
      .filter(row => row.time >= day && row.time < nextDay);
    const maxRain = Math.max(0, ...rows.map(row => row.precip));
    const wetHours = rows.filter(row => row.precip >= settings.stopThreshold).length;
    const maxChance = Math.max(0, ...rows.map(row => row.probability));
    const status = wetHours >= 2 ? 'stop' : maxRain >= settings.cautionThreshold || maxChance >= 50 ? 'caution' : 'dry';
    const card = document.createElement('article');
    card.className = 'daily-card';
    card.innerHTML = `<div><h3>${dayOffset === 0 ? 'Today' : formatDay(day)}</h3><p>Peak rain ${maxRain.toFixed(1)} mm/hour<br>${wetHours} heavier forecast hour${wetHours === 1 ? '' : 's'} · max chance ${maxChance}%</p></div><span class="daily-badge ${status}">${labelForClass(status)}</span>`;
    dailyCards.appendChild(card);
  }
}

function initialiseMap() {
  map = L.map('radarMap', { zoomControl: true }).setView([LOCATION.lat, LOCATION.lon], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  L.circleMarker([LOCATION.lat, LOCATION.lon], { radius: 7, color: '#0b2239', weight: 3, fillColor: '#ffffff', fillOpacity: 1 })
    .bindTooltip('Minster', { permanent: true, direction: 'top', offset: [0, -7] }).addTo(map);
}

async function fetchRadar() {
  const response = await fetch(RADAR_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Radar request failed (${response.status})`);
  const data = await response.json();
  radarHost = data.host;
  radarFrames = data.radar?.past || [];
  if (!radarFrames.length) throw new Error('No radar frames are currently available');
  radarFrameIndex = radarFrames.length - 1;
  $('radarSlider').max = String(radarFrames.length - 1);
  $('radarSlider').value = String(radarFrameIndex);
  showRadarFrame(radarFrameIndex);
  startRadarAnimation();
}

function showRadarFrame(index) {
  if (!radarFrames.length) return;
  radarFrameIndex = (index + radarFrames.length) % radarFrames.length;
  const frame = radarFrames[radarFrameIndex];
  const url = `${radarHost}${frame.path}/256/{z}/{x}/{y}/2/1_0.png`;
  if (radarLayer) map.removeLayer(radarLayer);
  radarLayer = L.tileLayer(url, { tileSize: 256, opacity: 0.68, zIndex: 10, maxNativeZoom: 7, maxZoom: 18 });
  radarLayer.addTo(map);
  $('radarSlider').value = String(radarFrameIndex);
  $('radarTime').textContent = `Observed radar: ${formatDateTime(new Date(frame.time * 1000))} · frame ${radarFrameIndex + 1} of ${radarFrames.length}`;
}
function startRadarAnimation() {
  clearInterval(radarTimer);
  $('radarPlayButton').textContent = 'Pause';
  radarTimer = setInterval(() => showRadarFrame(radarFrameIndex + 1), 900);
}
function pauseRadarAnimation() { clearInterval(radarTimer); radarTimer = null; $('radarPlayButton').textContent = 'Play'; }

async function refreshAll() {
  $('refreshButton').classList.add('refreshing');
  clearError();
  const results = await Promise.allSettled([fetchForecast(), fetchRadar()]);
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) showError(`Some live data could not load: ${failed.map(result => result.reason.message).join(' · ')}. Try refreshing in a moment.`);
  $('refreshButton').classList.remove('refreshing');
}

$('refreshButton').addEventListener('click', refreshAll);
$('radarSlider').addEventListener('input', (event) => { pauseRadarAnimation(); showRadarFrame(Number(event.target.value)); });
$('radarBack').addEventListener('click', () => { pauseRadarAnimation(); showRadarFrame(radarFrameIndex - 1); });
$('radarForward').addEventListener('click', () => { pauseRadarAnimation(); showRadarFrame(radarFrameIndex + 1); });
$('radarPlayButton').addEventListener('click', () => radarTimer ? pauseRadarAnimation() : startRadarAnimation());
$('settingsButton').addEventListener('click', () => { $('settingsPanel').classList.remove('hidden'); $('settingsPanel').setAttribute('aria-hidden', 'false'); $('settingsPanel').scrollIntoView({ behavior: 'smooth' }); });
$('closeSettings').addEventListener('click', () => { $('settingsPanel').classList.add('hidden'); $('settingsPanel').setAttribute('aria-hidden', 'true'); });
$('saveSettings').addEventListener('click', () => {
  settings = { cautionThreshold: Number($('cautionThreshold').value), stopThreshold: Number($('stopThreshold').value), prolongedMinutes: Number($('prolongedMinutes').value) };
  saveSettings();
  $('settingsPanel').classList.add('hidden'); $('settingsPanel').setAttribute('aria-hidden', 'true');
  if (forecastData) renderForecast(forecastData);
});

function initialiseSettings() {
  $('cautionThreshold').value = settings.cautionThreshold;
  $('stopThreshold').value = settings.stopThreshold;
  $('prolongedMinutes').value = settings.prolongedMinutes;
}

initialiseSettings();
initialiseMap();
refreshAll();
setInterval(fetchForecast, 10 * 60 * 1000);
setInterval(fetchRadar, 10 * 60 * 1000);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
