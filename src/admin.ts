import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Author, CommitStore } from "./commit-store.js";

type AdminConfig = { email: string; passwordHash: string; sessionSecret: string };
const failedLogins = new Map<string, { attempts: number; until: number }>();

export async function handleAdmin(request: IncomingMessage, response: ServerResponse, store: CommitStore, config: AdminConfig): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/admin")) return false;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");

  if (!config.email || !config.passwordHash || !config.sessionSecret) {
    response.writeHead(503).end("Admin is not configured");
    return true;
  }

  const session = getSession(request, config.sessionSecret);
  if (url.pathname === "/admin/login" && request.method === "POST") {
    const form = await readForm(request);
    const remote = request.socket.remoteAddress ?? "unknown";
    const attempts = failedLogins.get(remote);
    if (attempts && attempts.until > Date.now() && attempts.attempts >= 5) {
      sendHtml(response, page("Вход", `<h1>Слишком много попыток</h1><p>Попробуйте через 15 минут.</p>`, false), 429);
      return true;
    }
    if (form.get("email")?.toLowerCase() === config.email.toLowerCase() && checkPassword(form.get("password") ?? "", config.passwordHash)) {
      failedLogins.delete(remote);
      const expires = Date.now() + 12 * 60 * 60 * 1000;
      const nonce = randomBytes(16).toString("hex");
      const payload = `${expires}.${nonce}`;
      const signature = sign(payload, config.sessionSecret);
      response.setHeader("Set-Cookie", `admin_session=${payload}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=43200`);
      redirect(response, "/admin");
      return true;
    }
    failedLogins.set(remote, { attempts: (attempts?.until ?? 0) > Date.now() ? attempts!.attempts + 1 : 1, until: Date.now() + 15 * 60 * 1000 });
    sendHtml(response, loginPage(true), 401);
    return true;
  }

  if (!session) {
    if (url.pathname !== "/admin/login") { redirect(response, "/admin/login"); return true; }
    sendHtml(response, loginPage(false));
    return true;
  }

  if (url.pathname === "/admin/login" && request.method === "GET") {
    redirect(response, "/admin");
    return true;
  }

  if (url.pathname === "/admin/logout" && request.method === "POST") {
    const form = await readForm(request);
    if (!validCsrf(form, session, config.sessionSecret)) { response.writeHead(403).end(); return true; }
    response.setHeader("Set-Cookie", "admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0");
    redirect(response, "/admin/login");
    return true;
  }

  const csrf = sign(session, config.sessionSecret);
  if (request.method === "POST") {
    const form = await readForm(request);
    if (!validCsrf(form, session, config.sessionSecret)) { response.writeHead(403).end(); return true; }
    const id = Number(form.get("id"));
    try {
      if (url.pathname === "/admin/hide" && Number.isSafeInteger(id)) store.setHidden(id, form.get("hidden") === "1");
      else if (url.pathname === "/admin/merge" && Number.isSafeInteger(id)) store.mergeAuthor(id, Number(form.get("target")));
      else if (url.pathname === "/admin/unmerge" && Number.isSafeInteger(id)) store.unmergeAuthor(id);
      else { response.writeHead(404).end(); return true; }
      redirect(response, "/admin/people");
    } catch (error) {
      sendHtml(response, page("Ошибка", `<h1>Не удалось сохранить</h1><p>${escapeHtml(String(error))}</p>`, true, csrf), 400);
    }
    return true;
  }

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    const authors = combinedAuthors(store.authors());
    const repositories = store.repositories();
    const total7 = authors.reduce((sum, author) => sum + author.last_7, 0);
    const total30 = authors.reduce((sum, author) => sum + author.last_30, 0);
    const recorded = new Map(store.trend(30).map((row) => [row.day, row.commits]));
    const trend = Array.from({ length: 30 }, (_, index) => {
      const day = new Date(Date.now() + 3 * 60 * 60 * 1000 - (29 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return { day, commits: recorded.get(day) ?? 0 };
    });
    const max = Math.max(1, ...trend.map((row) => row.commits));
    const weekdays = store.weekdays();
    const names = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
    const content = `<h1>Активность команды</h1><div class="cards">
      <article><span>За 7 дней</span><strong>${total7}</strong></article><article><span>За 30 дней</span><strong>${total30}</strong></article>
      <article><span>Сотрудников</span><strong>${authors.length}</strong></article><article><span>Репозиториев</span><strong>${repositories.length}</strong></article></div>
      <section><h2>Коммиты за 30 дней</h2><div class="chart">${trend.map((row, index) => `<div class="bar-wrap" title="${escapeHtml(row.day)}: ${row.commits}"><div class="bar" style="height:${row.commits ? Math.max(4, row.commits / max * 100) : 0}%"></div><small>${index % 5 === 0 || index === 29 ? escapeHtml(row.day.slice(5)) : ""}</small></div>`).join("")}</div></section>
      <div class="columns"><section><h2>По сотрудникам · 30 дней</h2>${authorTable(authors.slice(0, 20))}</section>
      <section><h2>По дням недели · вся история</h2>${names.map((name, index) => `<div class="stat-line"><span>${name}</span><strong>${weekdays.find((row) => row.weekday === index)?.commits ?? 0}</strong></div>`).join("")}</section></div>
      <section><h2>Репозитории</h2>${repositories.map((repo) => `<div class="stat-line"><span>${escapeHtml(repo.full_name)}</span><strong>${repo.commit_count}</strong></div>`).join("")}</section>`;
    sendHtml(response, page("Обзор", content, true, csrf));
    return true;
  }

  if (url.pathname === "/admin/people") {
    const all = store.authors();
    const targets = all.filter((author) => !author.merged_into);
    const content = `<h1>Сотрудники и авторы</h1><p class="muted">Авторы добавляются из коммитов автоматически. Скрытые авторы не входят в сводку.</p>
      ${all.map((author) => `<article class="person"><div><a href="/admin/commits?author=${author.id}">${escapeHtml(author.name)}</a> ${author.github_login ? `<small>@${escapeHtml(author.github_login)}</small>` : ""}
      ${author.hidden ? `<small>Скрыт${author.merged_into ? " · объединён" : ""}</small>` : ""}<p>${author.commits} коммитов · за 30 дней: ${author.last_30} · последний: ${date(author.last_commit)}</p></div>
      ${author.merged_into ? `<form method="post" action="/admin/unmerge"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${author.id}"><button>Разъединить</button></form>` : `<form method="post" action="/admin/hide"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${author.id}"><input type="hidden" name="hidden" value="${author.hidden ? 0 : 1}"><button>${author.hidden ? "Показать" : "Скрыть"}</button></form>`}
      ${!author.merged_into && targets.length > 1 ? `<form method="post" action="/admin/merge"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${author.id}"><select name="target" required><option value="">Объединить с…</option>${targets.filter((target) => target.id !== author.id).map((target) => `<option value="${target.id}">${escapeHtml(target.name)}</option>`).join("")}</select><button>Объединить</button></form>` : ""}</article>`).join("") || "Пока нет авторов."}`;
    sendHtml(response, page("Сотрудники", content, true, csrf));
    return true;
  }

  if (url.pathname === "/admin/commits") {
    const author = Number(url.searchParams.get("author")) || undefined;
    const repository = url.searchParams.get("repository") || undefined;
    const from = validDate(url.searchParams.get("from"));
    const to = validDate(url.searchParams.get("to"));
    const currentPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const commits = store.commits({ author, repository, from, to, page: currentPage });
    const content = `<h1>История коммитов</h1><form class="filters" method="get" action="/admin/commits">
      <select name="author"><option value="">Все авторы</option>${store.authors().filter((person) => !person.merged_into).map((person) => `<option value="${person.id}" ${person.id === author ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("")}</select>
      <select name="repository"><option value="">Все репозитории</option>${store.repositories().map((repo) => `<option value="${escapeHtml(repo.full_name)}" ${repo.full_name === repository ? "selected" : ""}>${escapeHtml(repo.full_name)}</option>`).join("")}</select>
      <label>С <input type="date" name="from" value="${from ?? ""}"></label><label>По <input type="date" name="to" value="${to ?? ""}"></label><button>Показать</button></form>
      ${commits.map((commit) => `<article class="commit"><div><a href="${escapeHtml(commit.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(commit.message.split("\n")[0])}</a><p>${escapeHtml(commit.author_name)} · ${escapeHtml(commit.repository)} · ${date(commit.committed_at)} · ${escapeHtml(commit.sha.slice(0, 8))}</p>${commit.summary ? `<p>${escapeHtml(commit.summary)}</p>` : ""}</div></article>`).join("") || "Коммиты не найдены."}
      <nav class="pagination">${currentPage > 1 ? `<a href="${pageUrl(url, currentPage - 1)}">← Назад</a>` : ""}<span>Страница ${currentPage}</span>${commits.length === 50 ? `<a href="${pageUrl(url, currentPage + 1)}">Вперёд →</a>` : ""}</nav>`;
    sendHtml(response, page("Коммиты", content, true, csrf));
    return true;
  }

  if (url.pathname === "/admin/import") {
    const repositories = store.repositories();
    const branches = store.branches();
    const content = `<h1>Загрузка истории</h1><p class="muted">История загружается в фоне. Сюда входят коммиты из доступных существующих веток.</p>
      ${repositories.map((repo) => `<section><h2>${escapeHtml(repo.full_name)}</h2><p>Статус: ${escapeHtml(repo.status)} · ${repo.commit_count} коммитов</p>${repo.error ? `<p class="error">${escapeHtml(repo.error)}</p>` : ""}
      ${branches.filter((branch) => branch.repository === repo.full_name).map((branch) => `<div class="stat-line"><span>${escapeHtml(branch.branch)}</span><strong>${escapeHtml(branch.status)}</strong></div>${branch.error ? `<p class="error">${escapeHtml(branch.error)}</p>` : ""}`).join("")}</section>`).join("") || "Репозитории ещё не найдены."}`;
    sendHtml(response, page("Загрузка", content, true, csrf));
    return true;
  }
  response.writeHead(404).end();
  return true;
}

function combinedAuthors(authors: Author[]): Author[] {
  const roots = new Map(authors.filter((author) => !author.merged_into && !author.hidden).map((author) => [author.id, { ...author }]));
  for (const author of authors) {
    if (!author.merged_into) continue;
    const root = roots.get(author.merged_into);
    if (root) {
      root.commits += author.commits;
      root.last_7 += author.last_7;
      root.last_30 += author.last_30;
      if (author.last_commit && (!root.last_commit || author.last_commit > root.last_commit)) root.last_commit = author.last_commit;
    }
  }
  return [...roots.values()].sort((a, b) => b.last_30 - a.last_30);
}

function authorTable(authors: Author[]): string {
  return `<div class="table"><div class="table-head"><span>Автор</span><span>7 дн.</span><span>30 дн.</span><span>Последний</span></div>${authors.map((author) => `<a class="table-row" href="/admin/commits?author=${author.id}"><span>${escapeHtml(author.name)}</span><span>${author.last_7}</span><span>${author.last_30}</span><span>${date(author.last_commit)}</span></a>`).join("")}</div>`;
}

function loginPage(error: boolean): string {
  return page("Вход", `<div class="login"><h1>Вход в админку</h1>${error ? `<p class="error">Неверный email или пароль</p>` : ""}<form method="post" action="/admin/login"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Пароль<input name="password" type="password" autocomplete="current-password" required></label><button>Войти</button></form></div>`, false);
}

function page(title: string, content: string, authenticated: boolean, csrf = ""): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Manager Bot</title><style>${css}${mobileHeaderCss}</style></head><body>
    ${authenticated ? `<header><a class="brand" href="/admin">Manager Bot</a><nav><a href="/admin">Обзор</a><a href="/admin/people">Сотрудники</a><a href="/admin/commits">Коммиты</a><a href="/admin/import">Загрузка</a></nav><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="quiet">Выйти</button></form></header>` : ""}
    <main>${content}</main></body></html>`;
}

const css = `:root{color-scheme:light dark;font-family:Inter,system-ui,sans-serif;background:#f5f7fb;color:#172033}*{box-sizing:border-box}body{margin:0}header{display:flex;align-items:center;gap:24px;padding:16px max(20px,calc((100vw - 1180px)/2));background:#fff;border-bottom:1px solid #dde3eb}header nav{display:flex;gap:20px;flex:1;flex-wrap:wrap}.brand{font-weight:750;font-size:18px}a{color:#305cb8;text-decoration:none}header a{color:inherit}a:hover{text-decoration:underline}main{max-width:1180px;margin:36px auto;padding:0 20px}h1{font-size:30px;margin:0 0 24px}h2{font-size:18px;margin:0 0 16px}p{line-height:1.5}.muted,small,.commit p,.person p{color:#647084}section,article{background:#fff;border:1px solid #e0e6ef;border-radius:14px;padding:20px;margin-bottom:18px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.cards article{display:flex;flex-direction:column;gap:14px}.cards strong{font-size:32px}.columns{display:grid;grid-template-columns:2fr 1fr;gap:18px}.chart{height:170px;display:flex;align-items:end;gap:5px;overflow:auto}.bar-wrap{height:100%;min-width:19px;flex:1;display:flex;flex-direction:column;justify-content:end;text-align:center;gap:5px}.bar{background:#4678db;border-radius:4px 4px 0 0}.bar-wrap small{font-size:9px;white-space:nowrap}.stat-line{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #eef1f5;gap:16px}.table-head,.table-row{display:grid;grid-template-columns:2fr 55px 60px 120px;gap:8px;padding:10px;border-bottom:1px solid #eef1f5}.table-head{color:#647084;font-size:12px}.person{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.person>div{flex:1;min-width:230px}.person p,.commit p{margin:5px 0 0;font-size:13px}.person form{display:flex;gap:7px}.filters{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:20px}.filters label,.login label{display:flex;flex-direction:column;gap:6px}input,select,button{font:inherit;border-radius:8px;border:1px solid #cbd5e1;padding:9px 12px;background:#fff;color:inherit}button{background:#305cb8;color:#fff;border-color:#305cb8;cursor:pointer}button.quiet{background:transparent;color:inherit;border:0}.login{max-width:390px;margin:12vh auto;background:#fff;padding:30px;border-radius:16px;border:1px solid #e0e6ef}.login form{display:grid;gap:18px}.login input{width:100%}.error{color:#bf3030}.pagination{display:flex;gap:18px;margin:20px 0}@media(max-width:800px){header{align-items:flex-start;flex-wrap:wrap}header nav{order:3;width:100%}.cards{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}.table-head,.table-row{grid-template-columns:2fr 45px 55px 95px}}@media(max-width:480px){.cards{grid-template-columns:1fr 1fr}.table-head,.table-row{font-size:12px;grid-template-columns:1.5fr 35px 45px 75px}h1{font-size:25px}}@media(prefers-color-scheme:dark){:root{background:#111827;color:#edf2f8}header,section,article,.login{background:#1c2635;border-color:#334155}.muted,small,.commit p,.person p,.table-head{color:#a5b4c7}a{color:#92b5ff}header a{color:inherit}input,select{background:#111827;border-color:#475569}button{background:#638cf0;border-color:#638cf0;color:#0e1728}.stat-line,.table-head,.table-row{border-color:#334155}.bar{background:#7ca6ff}}`;
const mobileHeaderCss = `@media(max-width:800px){header{display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px}header nav{grid-column:1/-1;grid-row:2;width:auto;display:flex;gap:16px}header form{grid-column:2;grid-row:1}.person form{max-width:100%}}`;

function getSession(request: IncomingMessage, secret: string): string | null {
  const cookie = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith("admin_session="))?.slice(14);
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(sign(payload, secret), parts[2])) return null;
  if (Number(parts[0]) < Date.now()) return null;
  return payload;
}

function validCsrf(form: URLSearchParams, session: string, secret: string): boolean {
  return safeEqual(form.get("csrf") ?? "", sign(session, secret));
}

function sign(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("hex"); }
function safeEqual(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function checkPassword(value: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash || !/^[a-f0-9]+$/.test(salt) || !/^[a-f0-9]+$/.test(hash)) return false;
  return safeEqual(scryptSync(value, Buffer.from(salt, "hex"), 64).toString("hex"), hash);
}
async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) throw new Error("Invalid form content type");
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { const buffer = Buffer.from(chunk); length += buffer.length; if (length > 16_384) throw new Error("Form too large"); chunks.push(buffer); }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
function validDate(value: string | null): string | undefined { return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined; }
function pageUrl(url: URL, number: number): string { const copy = new URL(url); copy.searchParams.set("page", String(number)); return escapeHtml(copy.pathname + copy.search); }
function date(value: string | null): string { return value ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Minsk", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—"; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function sendHtml(response: ServerResponse, html: string, status = 200): void { response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html); }
function redirect(response: ServerResponse, location: string): void { response.writeHead(303, { Location: location }).end(); }
