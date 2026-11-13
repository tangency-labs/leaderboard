// Builds the daily SolidCraft merged-PR leaderboard into a static site directory.
// Usage: node scripts/build.mjs <site-dir>
// Env: GITHUB_TOKEN (search API), BASE_URL (public URL prefix), BACKFILL_DAYS (first run only)

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const REPO = "tangency-labs/solidcraft";
const MAINTAINERS = ["bherbruck", "jyviko"];
const TZ = "America/New_York";
const BASE = (process.env.BASE_URL || "https://solidcraft.io/leaderboard").replace(/\/$/, "");
const SITE = process.argv[2] || "site";
const BACKFILL = Number(process.env.BACKFILL_DAYS || 7);

// ---------- dates (US Eastern, midnight to midnight) ----------

const etParts = (ms) => {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: TZ,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
		})
			.formatToParts(ms)
			.map((x) => [x.type, x.value]),
	);
	return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};
const todayET = () => etParts(Date.now()).date;
const addDays = (date, n) => {
	const d = new Date(`${date}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
};
// UTC instant of 00:00 Eastern on the given date.
const dayStartMs = (date) => {
	const [y, m, d] = date.split("-").map(Number);
	for (const off of [4, 5]) {
		const t = Date.UTC(y, m - 1, d, off);
		const e = etParts(t);
		if (e.date === date && e.hour === 0) return t;
	}
	throw new Error(`cannot resolve ET midnight for ${date}`);
};
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const longDate = (date) =>
	new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
		timeZone: "UTC",
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

// ---------- GitHub ----------

const isBot = (u) =>
	u.type === "Bot" || /\[bot\]$/i.test(u.login) || /^(coderabbitai|dependabot|renovate|github-actions)$/i.test(u.login);

async function gh(path) {
	const headers = { accept: "application/vnd.github+json", "user-agent": "solidcraft-leaderboard" };
	if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	for (let attempt = 0; attempt < 5; attempt++) {
		const res = await fetch(`https://api.github.com${path}`, { headers });
		if (res.ok) return res.json();
		if (res.status === 403 || res.status === 429) {
			const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
			const wait = Math.min(Math.max(reset, 5000), 65000);
			console.warn(`rate limited, waiting ${Math.round(wait / 1000)}s`);
			await new Promise((r) => setTimeout(r, wait));
			continue;
		}
		if (res.status >= 500) {
			await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
			continue;
		}
		throw new Error(`GitHub ${res.status} for ${path}`);
	}
	throw new Error(`GitHub request kept failing: ${path}`);
}

const searchQuery = (login, start, end) =>
	`is:pr is:merged ${login ? `author:${login} ` : ""}merged:${iso(start)}..${iso(end - 1000)}`;

async function fetchDay(date) {
	const start = dayStartMs(date);
	const end = dayStartMs(addDays(date, 1));
	const q = encodeURIComponent(`repo:${REPO} ${searchQuery("", start, end)}`);
	const counts = new Map();
	let total = 0;
	let reported = 0;
	for (let page = 1; page <= 10; page++) {
		const r = await gh(`/search/issues?q=${q}&per_page=100&page=${page}`);
		reported = r.total_count;
		for (const it of r.items) {
			total++;
			const u = it.user;
			if (!u) continue;
			const c = counts.get(u.login) || { login: u.login, avatar: u.avatar_url, bot: isBot(u), count: 0 };
			c.count++;
			counts.set(u.login, c);
		}
		if (r.items.length < 100) break;
	}
	if (reported > total) console.warn(`${date}: search capped, ${total} of ${reported} PRs counted`);
	const all = [...counts.values()];
	const link = (login) =>
		`https://github.com/${REPO}/pulls?q=${encodeURIComponent(searchQuery(login, start, end))}`;
	const row = (c) => ({ login: c.login, avatar: c.avatar, count: c.count, url: link(c.login) });
	const isMaint = (c) => MAINTAINERS.includes(c.login.toLowerCase());
	const ranking = all
		.filter((c) => !c.bot && !isMaint(c))
		.sort((a, b) => b.count - a.count || a.login.localeCompare(b.login))
		.map(row);
	const maintainers = MAINTAINERS.map((m) => {
		const c = all.find((x) => x.login.toLowerCase() === m);
		return c
			? row(c)
			: { login: m, avatar: `https://github.com/${m}.png`, count: 0, url: link(m) };
	});
	return { date, total, ranking, maintainers };
}

// ---------- rendering ----------

// Self-contained so it can be inlined into the live page and re-run in the browser.
function renderBoard(data) {
	const esc = (s) =>
		String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const av = (u, s) => `${u.avatar}${u.avatar.includes("?") ? "&" : "?"}s=${s}`;
	let rank = 0;
	let prev = null;
	const rows = data.ranking
		.map((u, i) => {
			if (u.count !== prev) rank = i + 1;
			prev = u.count;
			return `<li class="row"><span class="rank">${rank}</span><img class="av" src="${esc(av(u, 80))}" width="40" height="40" alt="" loading="lazy"><a class="who" href="https://github.com/${esc(u.login)}">${esc(u.login)}</a><a class="count" href="${esc(u.url)}" title="Merged PRs by ${esc(u.login)}">${u.count}</a></li>`;
		})
		.join("");
	const list = rows
		? `<ol class="rows">${rows}</ol>`
		: `<p class="empty">No merged pull requests from contributors yet.</p>`;
	const maint = data.maintainers
		.map(
			(u) =>
				`<span class="m"><img class="av sm" src="${esc(av(u, 48))}" width="24" height="24" alt=""><a href="https://github.com/${esc(u.login)}">${esc(u.login)}</a> <a class="count sm" href="${esc(u.url)}">${u.count}</a></span>`,
		)
		.join("");
	return `${list}<p class="maint"><span class="label">Maintainers</span>${maint}</p><p class="total"><strong>${data.total}</strong> pull requests merged in total${data.final ? "" : ", counting live"}.</p>`;
}

const CSS = `
:root{--canvas:#181c24;--surface:#202630;--surface-strong:#293240;--ink:#f0f4fa;--muted:#b5becc;--line:#3b4657;--link:#96bef5;--action:#609eec;--focus:#b6d5ff;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--canvas:#f5f7fb;--surface:#fff;--surface-strong:#e8edf5;--ink:#181c24;--muted:#4a5565;--line:#d3dae6;--link:#1f58b5;--action:#1f58b5;--focus:#1f58b5;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:17px/1.6 "IBM Plex Sans Variable","IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(760px,calc(100% - 32px));margin:0 auto;padding:40px 0 64px}
a{color:var(--link);text-underline-offset:4px;text-decoration-thickness:1px}
a:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:4px}
.eyebrow{font:500 13px/1 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
h1{font-size:clamp(30px,6vw,46px);line-height:1.1;letter-spacing:-.035em;font-weight:550;margin:0 0 8px}
.sub{color:var(--muted);margin:0 0 28px}
.rows{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden}
.row{display:grid;grid-template-columns:36px 40px 1fr auto;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.rank{font:500 15px "IBM Plex Mono",ui-monospace,monospace;color:var(--muted);text-align:right}
.av{border-radius:50%;background:var(--surface-strong);display:block}
.av.sm{width:24px;height:24px}
.who{color:var(--ink);font-weight:500;text-decoration:none;overflow-wrap:anywhere}
.who:hover{text-decoration:underline}
.count{font:500 18px "IBM Plex Mono",ui-monospace,monospace;min-width:44px;text-align:center;padding:2px 12px;border-radius:999px;background:var(--surface-strong);color:var(--ink);text-decoration:none}
.count:hover{outline:1px solid var(--action)}
.count.sm{font-size:14px;min-width:0;padding:0 8px}
.empty{padding:28px;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}
.maint{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;margin:22px 0 0;color:var(--muted);font-size:15px}
.maint .label{font:500 13px "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}
.m{display:inline-flex;align-items:center;gap:8px}
.total{margin:14px 0 0;color:var(--muted);font-size:15px}
nav{display:flex;flex-wrap:wrap;gap:8px 20px;margin:36px 0 0;font-size:15px}
.days{list-style:none;margin:10px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 18px;font-size:15px}
h2{font-size:20px;letter-spacing:-.02em;font-weight:550;margin:44px 0 0}
.note{color:var(--muted);font-size:14px;margin:36px 0 0}
@media (max-width:480px){main{padding-top:24px}.row{grid-template-columns:28px 36px 1fr auto;gap:10px;padding:10px 12px}.av{width:36px;height:36px}}
`;

function page({ data, live, daysList, prev, next, hasPast }) {
	const date = data.date;
	const url = live ? `${BASE}/` : `${BASE}/${date}/`;
	const imgUrl = `${BASE}/${date}/og.png`;
	const top = data.ranking.slice(0, 3).map((u) => `${u.login} (${u.count})`);
	const title = `SolidCraft merged PRs, ${longDate(date)}`;
	const desc = `${data.total} pull requests merged into SolidCraft${top.length ? `. Top contributors: ${top.join(", ")}` : ""}.`;
	const root = live ? "" : "../";
	const nav = [
		live ? "" : `<a href="../">Today</a>`,
		prev ? `<a href="${root}${prev}/">&larr; ${prev}</a>` : "",
		next ? `<a href="${root}${next}/">${next} &rarr;</a>` : "",
		`<a href="https://github.com/${REPO}">SolidCraft on GitHub</a>`,
		`<a href="https://solidcraft.io">solidcraft.io</a>`,
	].join("");
	const past = live
		? `<h2>Past days</h2><ul class="days">${daysList.filter((d) => d.date !== date).map((d) => `<li><a href="${d.date}/">${d.date}</a> <span style="color:var(--muted)">${d.total} merged</span></li>`).join("") || "<li>None yet.</li>"}</ul>`
		: "";
	const script = live
		? `<script>
const renderBoard=${renderBoard.toString()};
const refresh=async()=>{try{const r=await fetch("leaderboard.json",{cache:"no-store"});if(!r.ok)return;const d=await r.json();
const el=document.getElementById("board");el.innerHTML=renderBoard(d);
document.getElementById("stamp").textContent="Updated "+new Date(d.generatedAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});}catch(e){}};
setInterval(refresh,300000);
</script>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SolidCraft">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${imgUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${imgUrl}">
<style>${CSS}</style>
</head>
<body>
<main>
<p class="eyebrow">SolidCraft &middot; daily leaderboard</p>
<h1>${longDate(date)}</h1>
<p class="sub">Contributors ranked by pull requests merged into <a href="https://github.com/${REPO}">${REPO}</a> that day (US Eastern). Merged only. <span id="stamp"></span></p>
<div id="board">${renderBoard(data)}</div>
${past}
<nav aria-label="Leaderboard navigation">${nav}</nav>
<p class="note">Select a count to see that person's merged pull requests for the day on GitHub. Bots are left out.</p>
</main>
${script}
</body>
</html>
`;
}

// ---------- og.png ----------

async function avatarData(u) {
	try {
		const res = await fetch(`${u.avatar}${u.avatar.includes("?") ? "&" : "?"}s=120`);
		if (!res.ok) return null;
		return `data:${res.headers.get("content-type") || "image/png"};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
	} catch {
		return null;
	}
}

async function ogHtml(data) {
	const top = data.ranking.slice(0, 5);
	const imgs = await Promise.all(top.map(avatarData));
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	let rank = 0;
	let prev = null;
	const rows = top
		.map((u, i) => {
			if (u.count !== prev) rank = i + 1;
			prev = u.count;
			const pic = imgs[i] ? `<img src="${imgs[i]}">` : `<div class="ph">${esc(u.login[0].toUpperCase())}</div>`;
			return `<div class="r"><span class="n">${rank}</span>${pic}<span class="l">${esc(u.login)}</span><span class="c">${u.count}</span></div>`;
		})
		.join("");
	return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#181c24;color:#f0f4fa;font-family:"IBM Plex Sans","DejaVu Sans","Liberation Sans",sans-serif;padding:52px 64px;display:flex;flex-direction:column}
.top{display:flex;justify-content:space-between;align-items:flex-start}
.k{font:500 22px "IBM Plex Mono","DejaVu Sans Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:#96bef5}
h1{font-size:54px;letter-spacing:-.03em;font-weight:600;margin:10px 0 0;line-height:1.1;white-space:nowrap}
.tot{text-align:right}.tot b{display:block;font-size:84px;line-height:1;color:#609eec;font-weight:600}.tot span{font-size:22px;color:#b5becc}
.list{margin-top:30px;border:1px solid #3b4657;border-radius:16px;background:#202630;overflow:hidden}
.r{display:flex;align-items:center;gap:20px;padding:0 28px;height:64px;border-top:1px solid #3b4657}.r:first-child{border-top:0}
.n{width:34px;text-align:right;font:500 26px "DejaVu Sans Mono",monospace;color:#969eac}
img,.ph{width:46px;height:46px;border-radius:50%;background:#293240}.ph{display:flex;align-items:center;justify-content:center;font-size:24px}
.l{flex:1;font-size:30px;font-weight:500}.c{font:500 32px "DejaVu Sans Mono",monospace;background:#293240;border-radius:999px;padding:2px 22px}
.empty{padding:40px;font-size:28px;color:#b5becc}
.foot{margin-top:auto;font-size:22px;color:#969eac}
</style>
<div class="top"><div><div class="k">SolidCraft daily leaderboard</div><h1>${esc(longDate(data.date).replace(/^(\w+), (\w{3})\w*/, '$1, $2'))}</h1></div><div class="tot"><b>${data.total}</b><span>PRs merged</span></div></div>
<div class="list">${rows || `<div class="empty">No contributor PRs merged yet.</div>`}</div>
<div class="foot">Merged pull requests into tangency-labs/solidcraft, US Eastern</div>`;
}

// ---------- main ----------

const readJson = async (p) => {
	try {
		return JSON.parse(await readFile(p, "utf8"));
	} catch {
		return null;
	}
};
const stable = (d) => JSON.stringify({ ...d, generatedAt: undefined });

async function listDays() {
	const out = [];
	for (const e of await readdir(SITE, { withFileTypes: true })) {
		if (e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)) {
			const d = await readJson(join(SITE, e.name, "data.json"));
			if (d) out.push({ date: d.date, total: d.total, final: !!d.final });
		}
	}
	return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

await mkdir(SITE, { recursive: true });
const today = todayET();
const existing = await listDays();
const wanted = [today, addDays(today, -1)];
if (existing.length === 0) for (let i = 2; i <= BACKFILL; i++) wanted.push(addDays(today, -i));
// Also close out any earlier day that never got its final pass.
for (const d of existing) if (!d.final && d.date < today && !wanted.includes(d.date)) wanted.push(d.date);

let browser;
const changedDates = [];
for (const date of wanted) {
	const old = await readJson(join(SITE, date, "data.json"));
	if (old?.final) continue; // frozen
	const data = await fetchDay(date);
	data.final = date < today;
	data.generatedAt = new Date().toISOString();
	if (old && stable(old) === stable(data)) continue;
	await mkdir(join(SITE, date), { recursive: true });
	await writeFile(join(SITE, date, "data.json"), `${JSON.stringify(data, null, 1)}\n`);
	if (date === today) await writeFile(join(SITE, "leaderboard.json"), `${JSON.stringify(data, null, 1)}\n`);
	browser ||= await chromium.launch({ channel: "chrome" });
	const pg = await browser.newPage({ viewport: { width: 1200, height: 630 } });
	await pg.setContent(await ogHtml(data), { waitUntil: "load" });
	await pg.screenshot({ path: join(SITE, date, "og.png") });
	await pg.close();
	changedDates.push(date);
	console.log(`${date}: ${data.total} merged, ${data.ranking.length} ranked${data.final ? " (final)" : ""}`);
}
await browser?.close();

// Pages are deterministic from stored data, so rewriting unchanged ones produces no diff.
const days = await listDays();
const asc = days.map((d) => d.date).sort();
for (const d of days) {
	const data = await readJson(join(SITE, d.date, "data.json"));
	const idx = asc.indexOf(d.date);
	await writeFile(
		join(SITE, d.date, "index.html"),
		page({ data, live: false, daysList: days, prev: asc[idx - 1], next: asc[idx + 1] }),
	);
}
const todayData = await readJson(join(SITE, today, "data.json"));
if (todayData) {
	await writeFile(join(SITE, "index.html"), page({ data: todayData, live: true, daysList: days }));
}
await writeFile(join(SITE, ".nojekyll"), "");
await writeFile(join(SITE, "404.html"), `<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found. <a href="${BASE}/">Today's leaderboard</a>`);
console.log(`done, ${changedDates.length} day(s) updated`);
