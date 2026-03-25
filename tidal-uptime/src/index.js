const API_LIST = [
  "https://eu-central.monochrome.tf", "https://us-west.monochrome.tf",
  "https://arran.monochrome.tf", "https://api.monochrome.tf",
  "https://monochrome-api.samidy.com", "https://triton.squid.wtf",
  "https://wolf.qqdl.site", "https://maus.qqdl.site",
  "https://vogel.qqdl.site", "https://katze.qqdl.site",
  "https://hund.qqdl.site", "https://tidal.kinoplus.online",
  "https://hifi-one.spotisaver.net", "https://hifi-two.spotisaver.net",
  "https://ohio-1.monochrome.tf", "https://singapore-1.monochrome.tf",
  "https://frankfurt-1.monochrome.tf", "https://hifi.geeked.wtf"
];

const SEARCH_QUERY = "Beyoncé";
const TRACK_ID = "59727867";
const TIMEOUT_MS = 4000;
const ROTATION_STEP = 3;

export default {
  async scheduled(event, env, ctx) {
    const report = await performHealthCheck(env);
    await env.STATUS_STORE.put("HEALTH_REPORT", JSON.stringify(report));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      const report = JSON.parse(await env.STATUS_STORE.get("HEALTH_REPORT") || "{}");
      const history = JSON.parse(await env.STATUS_STORE.get("MONTHLY_HISTORY") || "{}");
      return new Response(generateHTML(report, history), { headers: { "Content-Type": "text/html" } });
    }
    if (url.pathname.includes("/force")) {
      const report = await performHealthCheck(env);
      await env.STATUS_STORE.put("HEALTH_REPORT", JSON.stringify(report));
      return new Response("Forced update");
    }
    const cached = await env.STATUS_STORE.get("HEALTH_REPORT");
    return new Response(cached || JSON.stringify({ error: "No data" }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
};

async function performHealthCheck(env) {
  let offset = parseInt(await env.STATUS_STORE.get("ROTATION_OFFSET") || "0");
  const rotatedList = [...API_LIST.slice(offset), ...API_LIST.slice(0, offset)];
  await env.STATUS_STORE.put("ROTATION_OFFSET", ((offset + ROTATION_STEP) % API_LIST.length).toString());

  const results = [];
  const historicalData = JSON.parse(await env.STATUS_STORE.get("RAW_RESULTS") || "{}");
  
  // Monthly History structure: { "url": [ { date: "2024-05-01", up: 280, total: 288 }, ... ] }
  let monthlyHistory = JSON.parse(await env.STATUS_STORE.get("MONTHLY_HISTORY") || "{}");
  const today = new Date().toISOString().split('T')[0];

  for (const url of rotatedList) {
    try {
      const result = await checkSingleApi(url);
      results.push(result);
      historicalData[url] = result;
      updateHistory(monthlyHistory, url, today, (result.canSearch || result.canStream));
    } catch (e) {
      if ((e.message.includes("subrequests") || e.message.includes("limit")) && historicalData[url]) {
        results.push({ ...historicalData[url], note: "cached" });
        updateHistory(monthlyHistory, url, today, (historicalData[url].canSearch || historicalData[url].canStream));
      } else {
        results.push({ url, version: "0.0", canSearch: false, canStream: false, lastStatus: 500, lastError: e.message });
        updateHistory(monthlyHistory, url, today, false);
      }
    }
  }

  await env.STATUS_STORE.put("RAW_RESULTS", JSON.stringify(historicalData));
  await env.STATUS_STORE.put("MONTHLY_HISTORY", JSON.stringify(monthlyHistory));

  // 3. Prepare Final Response (Stripped to just URL and Version)
  const sortByVersion = (a, b) => compareSemVer(b.version, a.version);

  return {
    lastUpdated: new Date().toISOString(),
    api: results
      .filter(r => r.canSearch)
      .sort(sortByVersion)
      .map(r => ({ url: r.url, version: r.version })),
    streaming: results
      .filter(r => r.canStream)
      .sort(sortByVersion)
      .map(r => ({ url: r.url, version: r.version })),
    down: results
      .filter(r => !r.canSearch && !r.canStream)
      .map(r => ({ url: r.url, status: r.lastStatus, error: r.lastError }))
  };
}

function updateHistory(history, url, date, isUp) {
  if (!history[url]) history[url] = [];
  
  let dayEntry = history[url].find(e => e.date === date);
  
  if (!dayEntry) {
    dayEntry = { date, up: 0, total: 0 };
    history[url].push(dayEntry);
  }
  
  dayEntry.total++;
  if (isUp) dayEntry.up++;
  
  // Keep last 30 days; the most recent (Today) is the last element
  if (history[url].length > 30) {
    history[url] = history[url].slice(-30);
  }
}

function generateHTML(report, history) {
  const rows = API_LIST.map(url => {
    const dayData = history[url] || [];
    
    // Calculate overall uptime from available history
    const totalChecks = dayData.reduce((acc, d) => acc + d.total, 0);
    const totalUp = dayData.reduce((acc, d) => acc + d.up, 0);
    const uptimePct = totalChecks > 0 ? ((totalUp / totalChecks) * 100).toFixed(2) : "0.00";
    
    // Check if currently down in the latest report
    const isDown = report.down?.some(d => d.url === url);

    // Create the timeline bars
    // We use a fixed-width container with flex-end so 1 bar stays right
    const blocks = dayData.map(d => {
      const dayPct = (d.up / d.total) * 100;
      let statusClass = 'healthy';
      if (dayPct < 99) statusClass = 'warning';
      if (dayPct < 90) statusClass = 'partial';
      if (dayPct < 50) statusClass = 'outage';
      
      return `<div class="day-block ${statusClass}" title="${d.date}: ${dayPct.toFixed(1)}% uptime (${d.up}/${d.total})"></div>`;
    }).join('');

    return `
      <div class="api-card">
        <div class="header-row">
          <div class="name">
            <span class="status-dot ${isDown ? 'red' : 'green'}"></span>
            ${url.replace('https://', '')}
          </div>
          <div class="pct">${uptimePct}%</div>
        </div>
        <div class="timeline">${blocks}</div>
        <div class="footer-row">
          <span>30 Days Ago</span>
          <span>Today</span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Monochrome Intelligence | Status</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg: #000; --card: #0d0d0d; --border: #1f1f1f;
          --green: #00ff88; --yellow: #ffd500; --orange: #ff9500; --red: #ff3b30;
          --text: #fff; --dim: #666;
        }
        body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; padding: 60px 20px; }
        .container { max-width: 650px; margin: 0 auto; }
        h1 { font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: var(--dim); margin-bottom: 40px; display: flex; align-items: center; gap: 10px; }
        h1::after { content: ""; flex: 1; height: 1px; background: var(--border); }
        .api-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 24px; }
        .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .name { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; }
        .green { background: var(--green); box-shadow: 0 0 12px var(--green); }
        .red { background: var(--red); box-shadow: 0 0 12px var(--red); }
        .pct { color: var(--green); font-family: 'JetBrains Mono', monospace; font-size: 15px; }
        
        /* THE GRAPH FIX: justify-content pins items to the right */
        .timeline { display: flex; gap: 4px; height: 34px; justify-content: flex-end; align-items: flex-end; }
        .day-block { width: 12px; height: 100%; border-radius: 2px; transition: transform 0.1s; }
        .day-block:hover { transform: scaleY(1.2); cursor: crosshair; }
        
        .healthy { background: var(--green); opacity: 0.8; }
        .warning { background: var(--yellow); }
        .partial { background: var(--orange); }
        .outage { background: var(--red); }
        
        .footer-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--dim); margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Infrastructure Status</h1>
        ${rows}
      </div>
    </body>
    </html>
  `;
}

// ... include checkSingleApi, fetchWithRetry, and compareSemVer as before ...
async function checkSingleApi(baseUrl) {
  const cleanUrl = baseUrl.replace(/\/$/, "");
  let res = { url: baseUrl, version: "0.0", canSearch: false, canStream: false, lastStatus: 200, lastError: null };
  const trackResponse = await fetchWithRetry(`${cleanUrl}/track?id=${TRACK_ID}`);
  let trackData = null;
  if (trackResponse && trackResponse.ok) {
    trackData = await trackResponse.json();
    res.canStream = trackData?.data?.assetPresentation === "FULL";
    res.version = trackData?.version || "0.0";
    if (res.canStream) { res.canSearch = true; }
  } else {
    res.lastStatus = trackResponse?.status || 504;
    res.lastError = "Track unreachable";
  }
  if (!res.canStream) {
    const searchResponse = await fetchWithRetry(`${cleanUrl}/search?s=${encodeURIComponent(SEARCH_QUERY)}`);
    if (searchResponse && searchResponse.ok) {
      const searchData = await searchResponse.json();
      res.canSearch = !!(searchData?.data?.items);
      if (res.version === "0.0") res.version = searchData?.version || "0.0";
    }
  }
  if (baseUrl.endsWith(".qqdl.site")) {
    res.version = "2.6";
  }
  return res;
}

async function fetchWithRetry(url) {
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Binimum-Uptime/1.0", "X-Client": "Binimum-Uptime/v1.0" } });
      clearTimeout(id);
      if (response.ok || response.status < 500) return response;
    } catch (e) { clearTimeout(id); }
  }
  return null; 
}

function compareSemVer(v1, v2) {
  const a = (v1 || "0").split('.').map(Number);
  const b = (v2 || "0").split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const nA = a[i] || 0, nB = b[i] || 0;
    if (nA !== nB) return nA - nB;
  }
  return 0;
}