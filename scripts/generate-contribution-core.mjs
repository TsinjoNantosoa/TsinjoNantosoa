import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const USERNAME = process.env.GITHUB_USERNAME || "TsinjoNantosoa";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || "dist");
const DAYS_PER_WEEK = 7;
const WEEKS = 52;
const LOOP_SECONDS = 16;

const LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const THEMES = {
  dark: {
    background: "#080C0F",
    panel: "#0D1418",
    panelEdge: "#20302A",
    grid: "#26332F",
    primary: "#00EFA8",
    secondary: "#63FFD1",
    text: "#E6EDF3",
    muted: "#8B949E",
    shadow: "#001F16",
  },
  light: {
    background: "#F6FAF8",
    panel: "#FFFFFF",
    panelEdge: "#CBDAD3",
    grid: "#D6E0DB",
    primary: "#008F68",
    secondary: "#00A97A",
    text: "#17211D",
    muted: "#57645E",
    shadow: "#B7D8CC",
  },
};

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function fetchGraphqlContributions() {
  if (!TOKEN) throw new Error("No GitHub token available");
  const now = new Date();
  const from = addDays(now, -365);
  const query = `
    query ContributionCalendar($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
                contributionLevel
              }
            }
          }
        }
      }
    }
  `;
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-core-builder",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      query,
      variables: { login: USERNAME, from: from.toISOString(), to: now.toISOString() },
    }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL returned ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  const weeks = payload.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) throw new Error("GitHub GraphQL returned no contribution calendar");
  return weeks.flatMap((week) => week.contributionDays).map((day) => ({
    date: day.date,
    count: Number(day.contributionCount),
    level: LEVELS[day.contributionLevel] ?? 0,
  }));
}

async function fetchPublicContributions() {
  const response = await fetch(`https://github.com/users/${encodeURIComponent(USERNAME)}/contributions`, {
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: "text/html", "User-Agent": "ai-core-builder" },
  });
  if (!response.ok) throw new Error(`Public contribution calendar returned ${response.status}`);
  const html = await response.text();
  const tooltips = new Map();
  for (const match of html.matchAll(/<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    tooltips.set(match[1], match[2].replaceAll(",", ""));
  }
  const days = [];
  for (const match of html.matchAll(/<td\b[^>]*\bclass="ContributionCalendar-day"[^>]*><\/td>/g)) {
    const tag = match[0];
    const date = tag.match(/\bdata-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
    const level = Number(tag.match(/\bdata-level="([0-4])"/)?.[1] ?? 0);
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (!date || !id) continue;
    const label = tooltips.get(id) || "";
    const countMatch = label.match(/^(\d+) contributions? on\b/);
    const hasNoContributions = /^No contributions on\b/.test(label);
    if (!countMatch && !hasNoContributions) {
      throw new Error(`Unrecognized contribution tooltip for ${date}: ${label || "(missing)"}`);
    }
    const count = countMatch ? Number(countMatch[1]) : 0;
    if ((count === 0 && level !== 0) || (count > 0 && level === 0)) {
      throw new Error(`Inconsistent contribution count and level for ${date}`);
    }
    days.push({ date, count, level });
  }
  if (days.length < 350) throw new Error(`Only ${days.length} public contribution days were parsed`);
  const sortedDays = days.sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(sortedDays.map((day) => day.date)).size !== sortedDays.length) {
    throw new Error("Duplicate dates found in the public contribution calendar");
  }
  for (let index = 1; index < sortedDays.length; index += 1) {
    const expected = isoDate(addDays(new Date(`${sortedDays[index - 1].date}T00:00:00Z`), 1));
    if (sortedDays[index].date !== expected) {
      throw new Error(`Contribution calendar gap between ${sortedDays[index - 1].date} and ${sortedDays[index].date}`);
    }
  }
  return sortedDays;
}

async function getContributionData() {
  if (TOKEN) {
    try {
      return { days: await fetchGraphqlContributions(), source: "GitHub GraphQL API" };
    } catch (error) {
      console.warn(`GraphQL unavailable (${error.message}); using the public GitHub calendar.`);
    }
  }
  return { days: await fetchPublicContributions(), source: "public GitHub contribution calendar" };
}

function normalizeCalendar(inputDays) {
  const today = isoDate(new Date());
  const byDate = new Map(
    inputDays
      .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && day.date <= today)
      .map((day) => [day.date, { ...day, count: Math.max(0, day.count), level: Math.max(0, Math.min(4, day.level)) }]),
  );
  const available = [...byDate.keys()].sort();
  if (!available.length) throw new Error("Contribution data contained no usable dates");
  const end = new Date(`${available.at(-1)}T00:00:00Z`);
  const currentWeekStart = addDays(end, -end.getUTCDay());
  const start = addDays(currentWeekStart, -(WEEKS - 1) * DAYS_PER_WEEK);
  const days = [];
  for (let offset = 0; offset < WEEKS * DAYS_PER_WEEK; offset += 1) {
    const date = addDays(start, offset);
    if (date > end) continue;
    const key = isoDate(date);
    const value = byDate.get(key);
    if (!value) continue;
    days.push({ ...value, column: Math.floor(offset / DAYS_PER_WEEK), row: offset % DAYS_PER_WEEK });
  }
  if (!days.length) throw new Error("The latest 52-week window is empty");
  return { days, start: isoDate(start), end: isoDate(end) };
}

function selectParticles(days, maximum = 18) {
  const active = days.filter((day) => day.count > 0).sort((a, b) => a.column - b.column || b.level - a.level);
  if (active.length <= maximum) return active;
  return Array.from({ length: maximum }, (_, index) => active[Math.round((index * (active.length - 1)) / (maximum - 1))]);
}

function renderSvg(themeName, calendar, source) {
  const theme = THEMES[themeName];
  const gridX = 34;
  const gridY = 92;
  const pitch = 11;
  const coreX = 770;
  const coreY = 151;
  const particles = selectParticles(calendar.days);

  const cells = calendar.days.map((day) => {
    const x = gridX + day.column * pitch;
    const y = gridY + day.row * pitch;
    const delay = (day.column / WEEKS) * 12.7;
    const label = `${day.count} contribution${day.count === 1 ? "" : "s"} on ${day.date}`;
    const marker = day.level > 0
      ? `<circle class="energy level-${day.level}" cx="${x + 4}" cy="${y + 4}" r="${(0.8 + day.level * 0.55).toFixed(2)}" style="animation-delay:${delay.toFixed(2)}s" />`
      : "";
    return `<g><title>${escapeXml(label)}</title><rect class="cell level-${day.level}" x="${x}" y="${y}" width="8" height="8" rx="2" />${marker}</g>`;
  }).join("");

  const particleMarkup = particles.map((day, index) => {
    const x = gridX + day.column * pitch + 4;
    const y = gridY + day.row * pitch + 4;
    const start = Math.min(0.84, 0.06 + (day.column / (WEEKS - 1)) * 0.70);
    const end = Math.min(0.94, start + 0.075);
    const controlX = Math.round((x + coreX) / 2);
    const controlY = index % 2 === 0 ? 55 : 247;
    return `
      <circle class="particle" r="${day.level >= 3 ? 2.6 : 2.1}">
        <animateMotion dur="${LOOP_SECONDS}s" repeatCount="indefinite" calcMode="spline"
          keyPoints="0;0;1;1" keyTimes="0;${start.toFixed(3)};${end.toFixed(3)};1"
          keySplines="0 0 1 1;0.2 0.8 0.2 1;0 0 1 1"
          path="M ${x} ${y} Q ${controlX} ${controlY} ${coreX} ${coreY}" />
        <animate attributeName="opacity" dur="${LOOP_SECONDS}s" repeatCount="indefinite"
          values="0;0;1;0;0" keyTimes="0;${start.toFixed(3)};${(start + 0.012).toFixed(3)};${end.toFixed(3)};1" />
      </circle>`;
  }).join("");

  const networkNodes = [
    [770, 103], [811, 126], [811, 176], [770, 199], [729, 176], [729, 126],
  ];
  const networkLines = networkNodes.map(([x, y]) => `<line x1="${coreX}" y1="${coreY}" x2="${x}" y2="${y}" />`).join("");
  const nodes = networkNodes.map(([x, y], index) => `<circle class="network-node node-${index}" cx="${x}" cy="${y}" r="5" />`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300" role="img" aria-labelledby="title description">
  <title id="title">AI Core Builder contribution visualization for ${escapeXml(USERNAME)}</title>
  <desc id="description">The latest 52 weeks of available GitHub contributions form an engineering signal grid. A geometric scanner routes selected active signals into an AI core.</desc>
  <defs>
    <filter id="glow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
    <linearGradient id="scan-gradient" x1="0" x2="1">
      <stop offset="0" stop-color="${theme.primary}" stop-opacity="0" />
      <stop offset="0.5" stop-color="${theme.secondary}" stop-opacity="0.35" />
      <stop offset="1" stop-color="${theme.primary}" stop-opacity="0" />
    </linearGradient>
    <style>
      :root { color-scheme: ${themeName}; }
      .label { font: 600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 2.2px; fill: ${theme.text}; }
      .micro { font: 500 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 1.2px; fill: ${theme.muted}; }
      .cell { fill: ${theme.grid}; stroke: ${theme.panelEdge}; stroke-width: .45; }
      .cell.level-1 { fill: ${theme.primary}; opacity: .28; }
      .cell.level-2 { fill: ${theme.primary}; opacity: .46; }
      .cell.level-3 { fill: ${theme.primary}; opacity: .68; }
      .cell.level-4 { fill: ${theme.secondary}; opacity: .92; }
      .energy { fill: ${theme.secondary}; opacity: .72; transform-box: fill-box; transform-origin: center; animation: cell-pulse ${LOOP_SECONDS}s linear infinite; }
      .energy.level-3, .energy.level-4 { filter: url(#glow); }
      .particle { fill: ${theme.secondary}; filter: url(#glow); }
      .network { stroke: ${theme.primary}; stroke-width: 1; opacity: .32; }
      .network-node { fill: ${theme.panel}; stroke: ${theme.primary}; stroke-width: 1.5; animation: node-pulse 3.2s ease-in-out infinite; }
      .node-1, .node-4 { animation-delay: .5s; } .node-2, .node-5 { animation-delay: 1s; }
      .core-ring { fill: none; stroke: ${theme.primary}; stroke-width: 1.5; stroke-dasharray: 5 5; transform-box: fill-box; transform-origin: center; animation: rotate 12s linear infinite; }
      .core { fill: ${theme.primary}; filter: url(#glow); animation: core-pulse 2.8s ease-in-out infinite; }
      .label.online { fill: ${theme.secondary}; animation: online ${LOOP_SECONDS}s linear infinite; }
      @keyframes cell-pulse { 0%, 5%, 100% { opacity: .65; transform: scale(1); } 2.5% { opacity: 1; transform: scale(1.65); } }
      @keyframes node-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; filter: url(#glow); } }
      @keyframes core-pulse { 0%, 100% { opacity: .72; } 50% { opacity: 1; } }
      @keyframes rotate { to { transform: rotate(360deg); } }
      @keyframes online { 0%, 82%, 100% { opacity: 0; } 88%, 96% { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .energy, .network-node, .core-ring, .core, .online { animation: none; }
        .online { opacity: 1; }
        .animated-signal, .scanner { display: none; }
      }
    </style>
  </defs>

  <rect width="900" height="300" rx="18" fill="${theme.background}" />
  <rect x="16" y="16" width="868" height="268" rx="14" fill="${theme.panel}" stroke="${theme.panelEdge}" />
  <text class="label" x="34" y="48">AI CORE BUILDER</text>
  <text class="micro" x="34" y="68">PUBLIC ACTIVITY · 52 WEEK SIGNAL MAP</text>
  <text class="micro" x="866" y="48" text-anchor="end">${escapeXml(calendar.start)} → ${escapeXml(calendar.end)}</text>

  <g aria-label="Contribution grid">${cells}</g>

  <g class="scanner">
    <rect x="25" y="84" width="22" height="91" fill="url(#scan-gradient)" opacity="0">
      <animate attributeName="x" values="25;596;596" keyTimes="0;.82;1" dur="${LOOP_SECONDS}s" repeatCount="indefinite" />
      <animate attributeName="opacity" values="0;.55;0;0" keyTimes="0;.05;.84;1" dur="${LOOP_SECONDS}s" repeatCount="indefinite" />
    </rect>
    <g filter="url(#glow)">
      <polygon points="-8,0 -4,-7 5,-7 9,0 5,7 -4,7" fill="${theme.panel}" stroke="${theme.secondary}" stroke-width="1.5" />
      <circle cx="0" cy="0" r="3" fill="${theme.primary}" />
      <path d="M 2 -7 L 5 -12 M 5 -12 L 8 -12" fill="none" stroke="${theme.secondary}" stroke-width="1.2" />
      <path d="M 9 -4 L 18 0 L 9 4 Z" fill="${theme.primary}" opacity=".25" />
      <animateMotion path="M 34 82 C 175 73 450 89 598 82" dur="${LOOP_SECONDS}s" repeatCount="indefinite" />
    </g>
  </g>

  <g class="animated-signal">${particleMarkup}</g>

  <g aria-label="AI core">
    <g class="network">${networkLines}</g>
    ${nodes}
    <circle class="core-ring" cx="${coreX}" cy="${coreY}" r="31" />
    <circle cx="${coreX}" cy="${coreY}" r="21" fill="${theme.shadow}" stroke="${theme.secondary}" stroke-width="1.5" />
    <polygon class="core" points="770,137 782,144 782,158 770,165 758,158 758,144" />
    <circle cx="${coreX}" cy="${coreY}" r="4" fill="${theme.background}" />
    <text class="micro" x="${coreX}" y="230" text-anchor="middle">ENGINEERING SIGNAL PROCESSOR</text>
    <text class="label online" x="${coreX}" y="251" text-anchor="middle" fill="${theme.secondary}">AI CORE ONLINE</text>
  </g>

  <text class="micro" x="34" y="262">SOURCE · ${escapeXml(source.toUpperCase())}</text>
  <text class="micro" x="866" y="262" text-anchor="end">SIGNAL → CONTEXT → SYSTEM</text>
</svg>
`;
}

const result = await getContributionData();
const calendar = normalizeCalendar(result.days);
await mkdir(OUTPUT_DIR, { recursive: true });
await Promise.all(Object.keys(THEMES).map(async (theme) => {
  const output = path.join(OUTPUT_DIR, `ai-core-${theme}.svg`);
  await writeFile(output, renderSvg(theme, calendar, result.source), "utf8");
  console.log(`Generated ${output}`);
}));
console.log(`Rendered ${calendar.days.length} verified days for ${calendar.start} through ${calendar.end} from ${result.source}.`);
