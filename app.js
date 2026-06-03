const LOCATION = { name: 'Minster-in-Thanet', lat: 51.3349, lon: 1.3147 };
const FORECAST_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LOCATION.lat}&longitude=${LOCATION.lon}&current=temperature_2m,precipitation,rain,showers,weather_code,wind_speed_10m&hourly=precipitation_probability,precipitation,rain,showers,weather_code,wind_speed_10m,wind_gusts_10m&minutely_15=precipitation,rain,showers&timezone=Europe%2FLondon&forecast_days=3`;
const RADAR_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const SETTINGS_KEY = 'minster-weather-rules-v2';
const MORNING_SLOT = { startHour: 9, endHour: 13, label: '09:00–13:00' };
const RECOVERY_SLOT = { startHour: 13, endHour: 17, label: '13:00–17:00' };
const SHOWER_RISK_PROBABILITY = 45;
const IMMEDIATE_HEAVY_RATE = 1.2;
const BRIEF_SHOWER_MINUTES = 15;
const ADVICE_LOOKAHEAD_HOURS = 2;

const defaultSettings = { cautionThreshold: 0.2, stopThreshold: 0.7, prolongedMinutes: 30, advancedApiBase: '' };
let settings = loadSettings();
let map;
let radarLayer;
let radarFrames = [];
let radarHost = '';
let radarFrameIndex = 0;
let radarTimer;
let forecastData;
let nowcastData = null;
let metOfficeData = null;
let advancedErrors = [];
let quarterHourPoints = [];

function advancedApiBase() { return String(settings.advancedApiBase || '').trim().replace(/\/$/, ''); }

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
function minutesLabel(minutes) {
  if (!minutes) return '0 mins';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins} mins`;
  if (!mins) return `${hours}h`;
  return `${hours}h ${mins}m`;
}
function classForPoint(point) {
  if (point.rate >= settings.stopThreshold) return 'stop';
  if (point.rate >= settings.cautionThreshold || point.probability >= SHOWER_RISK_PROBABILITY) return 'caution';
  return 'dry';
}
function classForRate(rate) {
  if (rate >= settings.stopThreshold) return 'stop';
  if (rate >= settings.cautionThreshold) return 'caution';
  return 'dry';
}
function labelForClass(status) { return status === 'stop' ? 'Poor' : status === 'caution' ? 'Caution' : 'Good'; }
function timelineLabelForClass(status) { return status === 'stop' ? 'Stop' : status === 'caution' ? 'Caution' : 'Workable'; }
function weatherEmoji(status) { return status === 'stop' ? '🌧️' : status === 'caution' ? '🌦️' : '🪟'; }
function roundUpToQuarter(date) { const d = new Date(date); d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15); return d; }
function dayStart(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function atHour(date, hour) { const d = dayStart(date); d.setHours(hour, 0, 0, 0); return d; }

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


async function fetchAdvancedData() {
  const base = advancedApiBase();
  advancedErrors = [];
  if (!base) {
    nowcastData = null;
    metOfficeData = null;
    renderAdvancedPanels();
    return;
  }
  const [nowcastResult, metOfficeResult] = await Promise.allSettled([
    fetch(`${base}/api/nowcast`, { cache: 'no-store' }).then(checkJsonResponse),
    fetch(`${base}/api/metoffice`, { cache: 'no-store' }).then(checkJsonResponse)
  ]);
  if (nowcastResult.status === 'fulfilled') nowcastData = nowcastResult.value;
  else { nowcastData = null; advancedErrors.push(`Rainbow nowcast: ${nowcastResult.reason.message}`); }
  if (metOfficeResult.status === 'fulfilled') metOfficeData = metOfficeResult.value;
  else { metOfficeData = null; advancedErrors.push(`Met Office: ${metOfficeResult.reason.message}`); }
  renderAdvancedPanels();
  renderWorkAdvice();
}

async function checkJsonResponse(response) {
  let body = null;
  try { body = await response.json(); } catch { /* keep null */ }
  if (!response.ok) throw new Error(body?.error || `request failed (${response.status})`);
  return body;
}

function groupNowcastEvents(forecast) {
  const wet = (forecast || []).map(item => ({
    start: new Date(Number(item.timestampBegin) * 1000),
    end: new Date(Number(item.timestampEnd) * 1000),
    rate: Number(item.precipRate || 0),
    type: item.precipType || 'rain'
  }));
  const events = [];
  let current = null;
  wet.forEach(item => {
    const relevant = item.rate >= settings.cautionThreshold;
    if (relevant) {
      if (!current || item.start.getTime() - current.end.getTime() > 5 * 60000) {
        if (current) events.push(current);
        current = { start: item.start, end: item.end, maxRate: item.rate, wetMinutes: 1, type: item.type };
      } else {
        current.end = item.end;
        current.maxRate = Math.max(current.maxRate, item.rate);
        current.wetMinutes += 1;
      }
    } else if (current && item.start.getTime() - current.end.getTime() > 5 * 60000) {
      events.push(current); current = null;
    }
  });
  if (current) events.push(current);
  return events;
}

function nowcastSummary() {
  if (!nowcastData?.forecast) return null;
  const now = new Date();
  const events = groupNowcastEvents(nowcastData.forecast).filter(event => event.end > now);
  const first = events[0];
  if (!first) return { status: 'dry', title: 'No rain showing in the next 4 hours', detail: 'Rainbow nowcasting is not currently indicating a meaningful shower over Minster.', event: null };
  const minutesUntil = Math.max(0, Math.round((first.start - now) / 60000));
  const duration = Math.max(1, Math.round((first.end - first.start) / 60000));
  const isStop = first.maxRate >= settings.stopThreshold && duration >= settings.prolongedMinutes;
  const currentlyWet = first.start <= now;
  const status = isStop ? 'stop' : 'caution';
  const timing = currentlyWet ? 'Rain showing now' : `Rain may arrive in about ${minutesUntil} mins`;
  return {
    status,
    title: timing,
    detail: `Estimated spell ${formatTime(first.start)}–${formatTime(first.end)} · about ${duration} mins · peak ${first.maxRate.toFixed(1)} mm/hour.`,
    event: first
  };
}

function normalizeHour(date) { const d = new Date(date); d.setMinutes(0, 0, 0); return d.getTime(); }
function metOfficeAgreement() {
  if (!forecastData?.hourly || !metOfficeData?.hours?.length) return null;
  const openMap = new Map();
  forecastData.hourly.time.forEach((time, index) => openMap.set(normalizeHour(parseLocal(time)), Number(forecastData.hourly.precipitation[index] || 0)));
  const start = new Date();
  const end = new Date(start.getTime() + 12 * 3600000);
  const compared = [];
  metOfficeData.hours.forEach(hour => {
    const date = new Date(hour.time);
    if (date < start || date > end) return;
    const openRate = openMap.get(normalizeHour(date));
    if (openRate === undefined) return;
    const metRate = Number(hour.precipitationRate || 0);
    const openClass = classForRate(openRate);
    const metClass = classForRate(metRate);
    compared.push({ date, openRate, metRate, same: openClass === metClass, openClass, metClass });
  });
  if (!compared.length) return null;
  const agree = compared.filter(item => item.same).length;
  const fraction = agree / compared.length;
  const confidence = fraction >= 0.8 ? 'high' : fraction >= 0.55 ? 'medium' : 'low';
  const differences = compared.filter(item => !item.same).slice(0, 3).map(item => formatTime(item.date));
  return { confidence, agree, total: compared.length, differences };
}

function renderAdvancedPanels() {
  const setup = !advancedApiBase();
  const nowcast = nowcastSummary();
  const agreement = metOfficeAgreement();

  $('advancedSetupNotice').classList.toggle('hidden', !setup);
  $('nowcastBadge').className = `daily-badge ${setup ? 'muted' : (nowcast?.status || 'muted')}`;
  $('nowcastBadge').textContent = setup ? 'Setup needed' : nowcast ? labelForClass(nowcast.status) : 'Unavailable';
  $('nowcastHeading').textContent = setup ? 'Connect the private weather proxy' : nowcast?.title || 'Nowcast temporarily unavailable';
  $('nowcastDetail').textContent = setup
    ? 'Once connected, this card will show minute-by-minute rain arrival and estimated duration for the next four hours.'
    : nowcast?.detail || 'The standard Open-Meteo forecast and Rain Viewer map are still working.';

  $('confidenceBadge').className = `confidence-badge ${setup ? 'muted' : (agreement?.confidence || 'muted')}`;
  $('confidenceBadge').textContent = setup ? 'Setup needed' : agreement ? `${agreement.confidence[0].toUpperCase()}${agreement.confidence.slice(1)} confidence` : 'Unavailable';
  $('confidenceHeading').textContent = setup ? 'Met Office comparison not connected' : agreement ? `${agreement.agree} of ${agreement.total} hours broadly agree` : 'Waiting for comparable hourly data';
  $('confidenceDetail').textContent = setup
    ? 'The Met Office feed will act as a second opinion rather than silently replacing the current forecast.'
    : agreement
      ? (agreement.differences.length ? `The sources differ around ${agreement.differences.join(', ')}. Treat those times cautiously and check radar.` : 'Open-Meteo and the Met Office broadly agree across the next 12 hours.')
      : 'The Met Office response loaded, but there was not enough overlapping hourly data to score agreement.';

  $('advancedErrors').textContent = advancedErrors.length ? advancedErrors.join(' · ') : '';
  $('advancedErrors').classList.toggle('hidden', !advancedErrors.length);

  renderWorkAdvice();

  if (nowcast?.event && nowcast.status === 'stop') {
    const minutesUntil = Math.max(0, Math.round((nowcast.event.start - new Date()) / 60000));
    if (minutesUntil <= 120) $('roundDecision').textContent = minutesUntil <= 0 ? 'No — nowcast shows rain' : `Finish by ${formatTime(nowcast.event.start)}`;
  }
}


function groupForecastRainEvents(points) {
  const events = [];
  let current = null;
  points.forEach(point => {
    const wet = point.rate >= settings.cautionThreshold;
    if (wet) {
      if (!current) {
        current = {
          start: point.time,
          end: new Date(point.time.getTime() + 15 * 60000),
          maxRate: point.rate,
          blocks: 1
        };
      } else {
        current.end = new Date(point.time.getTime() + 15 * 60000);
        current.maxRate = Math.max(current.maxRate, point.rate);
        current.blocks += 1;
      }
    } else if (current) {
      events.push(current);
      current = null;
    }
  });
  if (current) events.push(current);
  return events;
}

function workAdvice() {
  const now = new Date();
  const end = new Date(now.getTime() + ADVICE_LOOKAHEAD_HOURS * 3600000);
  const points = quarterHourPoints.filter(point => point.time >= roundUpToQuarter(now) && point.time < end);
  const forecastEvents = groupForecastRainEvents(points);
  const riskBlocks = points.filter(point => point.probability >= SHOWER_RISK_PROBABILITY).length;
  const nowRate = forecastData ? Number(forecastData.current.precipitation || 0) * (3600 / Number(forecastData.current.interval || 900)) : 0;

  const rainbowEvents = nowcastData?.forecast
    ? groupNowcastEvents(nowcastData.forecast).filter(event => event.end > now && event.start < end)
    : [];
  const event = rainbowEvents[0] || forecastEvents[0] || null;
  const duration = event ? Math.max(1, Math.round((event.end - event.start) / 60000)) : 0;
  const maxRate = event ? Number(event.maxRate || 0) : 0;
  const currentlyWet = event ? event.start <= now : nowRate >= settings.cautionThreshold;
  const minutesUntil = event ? Math.max(0, Math.round((event.start - now) / 60000)) : null;
  const repeatedShowers = (rainbowEvents.length + forecastEvents.length >= 2) || riskBlocks >= 4;

  if (nowRate >= IMMEDIATE_HEAVY_RATE || (currentlyWet && maxRate >= IMMEDIATE_HEAVY_RATE)) {
    return {
      status: 'stop',
      heading: 'Stop cleaning for now',
      detail: `Proper rain is showing over Minster${maxRate ? `, peaking around ${maxRate.toFixed(1)} mm/hour` : ''}. Wait for it to pass before beginning another job.`
    };
  }

  if (event && maxRate >= settings.stopThreshold && duration >= settings.prolongedMinutes) {
    const timing = currentlyWet ? `Rain is showing now until about ${formatTime(event.end)}` : `Rain is likely from about ${formatTime(event.start)}–${formatTime(event.end)}`;
    return {
      status: 'stop',
      heading: 'Rain stop likely — do not begin another job',
      detail: `${timing}. Expected duration: about ${duration} mins · peak around ${maxRate.toFixed(1)} mm/hour. Finish the current house if practical, then pause.`
    };
  }

  if (event && maxRate >= settings.stopThreshold && duration <= BRIEF_SHOWER_MINUTES) {
    const timing = currentlyWet ? 'A short shower is showing now' : `A short shower may arrive in about ${minutesUntil} mins`;
    return {
      status: 'caution',
      heading: 'Brief shower likely — pause rather than cancel',
      detail: `${timing}. It is expected to last around ${duration} mins, with a peak near ${maxRate.toFixed(1)} mm/hour. Avoid starting a fresh house just before it arrives.`
    };
  }

  if (event && maxRate >= settings.cautionThreshold) {
    const timing = currentlyWet ? 'Light rain is showing now' : `Light rain may arrive in about ${minutesUntil} mins`;
    return {
      status: 'caution',
      heading: repeatedShowers ? 'Unsettled conditions — keep the afternoon recovery slot open' : 'Light rain risk — use judgement',
      detail: `${timing}. The next spell looks around ${duration} mins long, peaking near ${maxRate.toFixed(1)} mm/hour. Check the radar before setting off or starting another job.`
    };
  }

  if (repeatedShowers || riskBlocks >= 2) {
    return {
      status: 'caution',
      heading: 'Unsettled conditions — keep the afternoon recovery slot open',
      detail: 'No definite rain stop is showing yet, but shower risk is elevated during the next two hours. Continue cautiously and check the live radar between jobs.'
    };
  }

  return {
    status: 'dry',
    heading: 'Carry on — no meaningful interruption showing',
    detail: 'No rain stop or significant shower is currently showing for the next two hours. Keep an eye on the radar if nearby patches begin to build.'
  };
}

function renderWorkAdvice() {
  const advice = workAdvice();
  $('workAdviceCard').className = `work-advice ${advice.status}`;
  $('workAdviceBadge').className = `daily-badge ${advice.status}`;
  $('workAdviceBadge').textContent = labelForClass(advice.status);
  $('workAdviceHeading').textContent = advice.heading;
  $('workAdviceDetail').textContent = advice.detail;
}

function buildHourlyProbabilityMap(data) {
  const map = new Map();
  (data.hourly?.time || []).forEach((value, index) => {
    const time = parseLocal(value);
    time.setMinutes(0, 0, 0);
    map.set(time.getTime(), Number(data.hourly.precipitation_probability?.[index] || 0));
  });
  return map;
}

function buildQuarterHours(data) {
  const hourlyProbability = buildHourlyProbabilityMap(data);
  const times = data.minutely_15.time.map(parseLocal);
  const precipitation = data.minutely_15.precipitation || [];
  const rain = data.minutely_15.rain || precipitation;
  const showers = data.minutely_15.showers || [];
  return times.map((time, index) => {
    const hour = new Date(time); hour.setMinutes(0, 0, 0);
    return {
      time,
      precipitation15: Number(precipitation[index] || 0),
      rain15: Number(rain[index] || 0),
      showers15: Number(showers[index] || 0),
      rate: rainRateFrom15Min(precipitation[index]),
      probability: hourlyProbability.get(hour.getTime()) || 0
    };
  });
}

function findWetSpells(points) {
  const spells = [];
  let current = null;
  points.forEach((point) => {
    if (point.rate >= settings.stopThreshold) {
      if (!current) current = { start: point.time, end: new Date(point.time.getTime() + 15 * 60000), maxRate: point.rate, blocks: 1 };
      else { current.end = new Date(point.time.getTime() + 15 * 60000); current.maxRate = Math.max(current.maxRate, point.rate); current.blocks += 1; }
    } else if (current) { spells.push(current); current = null; }
  });
  if (current) spells.push(current);
  return spells.filter(spell => spell.blocks * 15 >= settings.prolongedMinutes);
}

function longestUsableStretch(points) {
  let longest = null;
  let current = null;
  points.forEach((point) => {
    if (classForPoint(point) !== 'stop') {
      if (!current) current = { start: point.time, end: new Date(point.time.getTime() + 15 * 60000), blocks: 1 };
      else { current.end = new Date(point.time.getTime() + 15 * 60000); current.blocks += 1; }
      if (!longest || current.blocks > longest.blocks) longest = { ...current };
    } else current = null;
  });
  return longest;
}

function slotPoints(points, date, slot) {
  const start = atHour(date, slot.startHour);
  const end = atHour(date, slot.endHour);
  return points.filter(point => point.time >= start && point.time < end);
}

function evaluateSlot(points, date, slot) {
  const rows = slotPoints(points, date, slot);
  const counts = { dry: 0, caution: 0, stop: 0 };
  rows.forEach(point => { counts[classForPoint(point)] += 1; });
  const dryMinutes = counts.dry * 15;
  const cautionMinutes = counts.caution * 15;
  const stopMinutes = counts.stop * 15;
  const likelyWorkableMinutes = Math.max(0, 240 - stopMinutes);
  const bestStretch = longestUsableStretch(rows);
  const maxProbability = Math.max(0, ...rows.map(point => point.probability));
  const maxRate = Math.max(0, ...rows.map(point => point.rate));
  let status = 'dry';
  if (stopMinutes >= 90 || (bestStretch && bestStretch.blocks * 15 < 90)) status = 'stop';
  else if (stopMinutes > 0 || cautionMinutes >= 60) status = 'caution';
  return { rows, dryMinutes, cautionMinutes, stopMinutes, likelyWorkableMinutes, bestStretch, maxProbability, maxRate, status };
}

function targetPlanningDay(now) {
  const todayRecoveryEnd = atHour(now, RECOVERY_SLOT.endHour);
  return now >= todayRecoveryEnd ? addDays(dayStart(now), 1) : dayStart(now);
}

function recommendationForSlots(morning, recovery) {
  const riskMinutes = morning.stopMinutes + Math.round(morning.cautionMinutes * 0.35 / 15) * 15;
  const recoveryCapacity = recovery.likelyWorkableMinutes;
  if (riskMinutes <= 30 && morning.stopMinutes === 0) {
    return { title: 'No afternoon cover needed', detail: 'The 09:00–13:00 round looks broadly workable. Keep the recovery slot as a fallback only.' };
  }
  if (recovery.status === 'stop' || recoveryCapacity < 90) {
    return { title: 'Poor day overall', detail: 'The morning has disruption risk and the 13:00–17:00 recovery slot also looks limited. Consider moving work where possible.' };
  }
  if (riskMinutes >= 150 || morning.stopMinutes >= 120) {
    return { title: 'Keep both available after 13:00', detail: `The morning may lose around ${minutesLabel(riskMinutes)}. The afternoon currently offers about ${minutesLabel(recoveryCapacity)} of usable time.` };
  }
  return { title: 'Keep one person free after 13:00', detail: `The morning may lose around ${minutesLabel(riskMinutes)} to heavier rain or shower risk. The afternoon looks suitable for catch-up work.` };
}

function renderPlanner(points) {
  const target = targetPlanningDay(new Date());
  const morning = evaluateSlot(points, target, MORNING_SLOT);
  const recovery = evaluateSlot(points, target, RECOVERY_SLOT);
  const recommendation = recommendationForSlots(morning, recovery);
  const today = dayStart(new Date());
  const heading = target.getTime() === today.getTime() ? "Today's round plan" : `${formatDay(target)}'s round plan`;
  $('plannerHeading').textContent = heading;
  $('plannerBadge').className = `planner-badge ${morning.status}`;
  $('plannerBadge').textContent = labelForClass(morning.status);

  const bestMorning = morning.bestStretch ? `${formatTime(morning.bestStretch.start)}–${formatTime(morning.bestStretch.end)}` : 'No clear stretch';
  const bestRecovery = recovery.bestStretch ? `${formatTime(recovery.bestStretch.start)}–${formatTime(recovery.bestStretch.end)}` : 'No clear stretch';
  $('plannerSummary').textContent = `Main round ${MORNING_SLOT.label}. Recovery slot ${RECOVERY_SLOT.label}. The recommendation accounts for heavier rain and lower-confidence shower-risk periods.`;
  $('morningBadge').className = `daily-badge ${morning.status}`;
  $('morningBadge').textContent = labelForClass(morning.status);
  $('morningWorkable').textContent = `${minutesLabel(morning.likelyWorkableMinutes)} potentially workable`;
  $('morningDetail').textContent = `Best usable stretch: ${bestMorning}. ${minutesLabel(morning.cautionMinutes)} flagged for shower risk · ${minutesLabel(morning.stopMinutes)} likely stop time.`;
  $('recoveryBadge').className = `daily-badge ${recovery.status}`;
  $('recoveryBadge').textContent = labelForClass(recovery.status);
  $('recoveryWorkable').textContent = `${minutesLabel(recovery.likelyWorkableMinutes)} potentially workable`;
  $('recoveryDetail').textContent = `Best catch-up stretch: ${bestRecovery}. ${minutesLabel(recovery.cautionMinutes)} flagged for shower risk · ${minutesLabel(recovery.stopMinutes)} likely stop time.`;
  $('coverRecommendation').textContent = recommendation.title;
  $('coverReason').textContent = recommendation.detail;
}

function renderForecast(data) {
  const points = buildQuarterHours(data);
  quarterHourPoints = points;
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
  const twoHourHasStop = nextTwoHours.some(p => classForPoint(p) === 'stop');
  const twoHourHasCaution = nextTwoHours.some(p => classForPoint(p) === 'caution');
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
  renderPlanner(points);
  renderTimeline(upcoming);
  renderDaily(data);
  renderAdvancedPanels();
}

function renderTimeline(points) {
  const timeline = $('timeline');
  timeline.innerHTML = '';
  points.forEach((point) => {
    const status = classForPoint(point);
    const button = document.createElement('button');
    button.className = `timeline-block ${status}`;
    button.type = 'button';
    button.title = `${formatDateTime(point.time)} · ${point.rate.toFixed(1)} mm/hour · ${point.probability}% rain chance · ${timelineLabelForClass(status)}`;
    button.dataset.hour = point.time.getMinutes() === 0 ? formatTime(point.time) : '';
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => {
      $('timelineDetail').textContent = `${formatDateTime(point.time)}: ${timelineLabelForClass(status)} · forecast rate ${point.rate.toFixed(1)} mm/hour (${point.precipitation15.toFixed(2)} mm during this 15-minute block) · ${point.probability}% hourly rain chance.`;
    });
    timeline.appendChild(button);
  });
}

function renderDaily(data) {
  const dailyCards = $('dailyCards');
  dailyCards.innerHTML = '';
  const times = data.hourly.time.map(parseLocal);
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const day = dayStart(addDays(new Date(), dayOffset));
    const nextDay = addDays(day, 1);
    const rows = times.map((time, i) => ({ time, precip: Number(data.hourly.precipitation[i] || 0), probability: Number(data.hourly.precipitation_probability[i] || 0) }))
      .filter(row => row.time >= day && row.time < nextDay);
    const maxRain = Math.max(0, ...rows.map(row => row.precip));
    const wetHours = rows.filter(row => row.precip >= settings.stopThreshold).length;
    const maxChance = Math.max(0, ...rows.map(row => row.probability));
    const status = wetHours >= 2 ? 'stop' : maxRain >= settings.cautionThreshold || maxChance >= SHOWER_RISK_PROBABILITY ? 'caution' : 'dry';
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
  const results = await Promise.allSettled([fetchForecast(), fetchRadar(), fetchAdvancedData()]);
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
  settings = { cautionThreshold: Number($('cautionThreshold').value), stopThreshold: Number($('stopThreshold').value), prolongedMinutes: Number($('prolongedMinutes').value), advancedApiBase: $('advancedApiBase').value.trim() };
  saveSettings();
  $('settingsPanel').classList.add('hidden'); $('settingsPanel').setAttribute('aria-hidden', 'true');
  if (forecastData) renderForecast(forecastData);
  fetchAdvancedData();
});

function initialiseSettings() {
  $('cautionThreshold').value = settings.cautionThreshold;
  $('stopThreshold').value = settings.stopThreshold;
  $('prolongedMinutes').value = settings.prolongedMinutes;
  $('advancedApiBase').value = settings.advancedApiBase || '';
}

initialiseSettings();
initialiseMap();
refreshAll();
setInterval(fetchForecast, 10 * 60 * 1000);
setInterval(fetchRadar, 10 * 60 * 1000);
setInterval(fetchAdvancedData, 10 * 60 * 1000);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
