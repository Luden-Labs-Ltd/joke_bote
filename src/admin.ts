import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Author, CommitRow, CommitStore } from "./commit-store.js";
import { generateAuthorInsight } from "./author-insight.js";

type AdminConfig = { email: string; passwordHash: string; sessionSecret: string; geminiApiKey?: string; geminiModel?: string };
const failedLogins = new Map<string, { attempts: number; until: number }>();

export async function handleAdmin(request: IncomingMessage, response: ServerResponse, store: CommitStore, config: AdminConfig): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/admin")) return false;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash("sha256").update(interactionJs).digest("base64")}'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
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
      if (url.pathname === "/admin/insight" && Number.isSafeInteger(id) && id > 0) {
        const author = combinedAuthors(store.authors()).find((person) => person.id === id);
        if (!author) { response.writeHead(404).end(); return true; }
        if (!config.geminiApiKey) { redirect(response, `/admin/people/${id}?insight_error=unavailable`); return true; }
        try {
          const insight = await generateAuthorInsight(author.name, store.authorActivity(id), config.geminiApiKey, config.geminiModel || "gemini-2.5-flash");
          store.saveAuthorInsight(id, insight.summary, insight.evidence, author.last_30);
          redirect(response, `/admin/people/${id}`);
        } catch (error) {
          console.error("Author insight failed", { authorId: id, error });
          redirect(response, `/admin/people/${id}?insight_error=failed`);
        }
        return true;
      }
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
    const top = authors.filter((author) => author.last_30 > 0).slice(0, 5).map((author, index) => ({ ...author, rank: index + 1, activity: store.authorActivity(author.id) }));
    const loading = repositories.some((repo) => repo.status !== "complete");
    const content = `<div class="page-title"><div><h1>Команда за 30 дней</h1><p class="muted">Коммиты показывают активность, а не качество работы.</p></div><a href="/admin/people">Все сотрудники →</a></div>
      ${loading ? '<p class="notice">История репозиториев ещё загружается. Цифры могут увеличиться.</p>' : ""}
      <div class="cards"><article><span>Коммитов за 30 дней</span><strong>${total30}</strong></article><article><span>За 7 дней</span><strong>${total7}</strong></article><article><span>Сотрудников</span><strong>${authors.length}</strong></article><article><span>Репозиториев</span><strong>${repositories.length}</strong></article></div>
      <section><div class="section-heading"><h2>Топ сотрудников · 30 дней</h2><small>По числу коммитов</small></div>${top.length ? top.map((person) => `<a class="leader-row" href="/admin/people/${person.id}"><span class="rank">${person.rank}</span><span class="leader-name"><strong>${escapeHtml(person.name)}</strong><small>${person.activity.activeDays} ${plural(person.activity.activeDays, "активный день", "активных дня", "активных дней")} · ${person.activity.repositoryCount} ${plural(person.activity.repositoryCount, "проект", "проекта", "проектов")}</small></span><strong class="leader-count">${person.last_30}</strong><span class="leader-label">коммитов</span></a>`).join("") : '<p class="muted">За последние 30 дней коммитов пока нет.</p>'}<a class="section-link" href="/admin/people">Посмотреть всех сотрудников →</a></section>
      <section><h2>Динамика коммитов · 30 дней</h2><div class="chart">${trend.map((row, index) => `<div class="bar-wrap" title="${escapeHtml(row.day)}: ${row.commits}"><div class="bar" style="height:${row.commits ? Math.max(4, row.commits / max * 100) : 0}%"></div><small>${index % 5 === 0 || index === 29 ? escapeHtml(row.day.slice(5)) : ""}</small></div>`).join("")}</div></section>`;
    sendHtml(response, page("Обзор", content, true, csrf));
    return true;
  }

  const profile = url.pathname.match(/^\/admin\/people\/(\d+)$/);
  if (profile) {
    const id = Number(profile[1]);
    const author = combinedAuthors(store.authors()).find((person) => person.id === id);
    if (!author) { response.writeHead(404).end(); return true; }
    const activity = store.authorActivity(id);
    const insight = store.authorInsight(id);
    const evidence = (insight?.evidence ?? []).map((sha) => store.authorCommitBySha(id, sha)).filter((commit) => commit !== undefined);
    const days = new Map(activity.days.map((row) => [row.day, row.commits]));
    const recentDays = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(Date.now() + 3 * 60 * 60 * 1000 - (6 - index) * 86_400_000).toISOString().slice(0, 10);
      return { day, commits: days.get(day) ?? 0 };
    });
    const recent7Total = recentDays.reduce((total, row) => total + row.commits, 0);
    const max = Math.max(1, ...recentDays.map((row) => row.commits));
    const loading = store.repositories().some((repo) => repo.status !== "complete");
    const content = `<a class="back-link" href="/admin/people">← Все сотрудники</a><h1>${escapeHtml(author.name)}</h1><p class="muted">Активный день = день с хотя бы одним коммитом.</p>
      ${loading ? '<p class="notice">История ещё загружается. Цифры могут увеличиться.</p>' : ""}
      <div class="cards profile-cards"><article><span>Коммитов за 30 дней</span><strong>${author.last_30}</strong></article><article><span>Активных дней</span><strong>${activity.activeDays}</strong></article><article><span>За 7 дней</span><strong>${recent7Total}</strong></article><article><span>Проектов за 30 дней</span><strong>${activity.repositoryCount}</strong></article></div>
      <section><div class="activity-heading"><div><h2>Коммиты по дням · последние 7 дней</h2><small>Даты и время — Минск</small></div><div class="last-commit"><span>Последний коммит</span><strong>${date(author.last_commit)}</strong></div></div>
      <div class="activity-days">${recentDays.map((row) => `<div class="activity-day"><span>${escapeHtml(dayLabel(row.day))}</span><div class="activity-track" aria-hidden="true"><div class="activity-fill" style="width:${row.commits ? Math.max(3, row.commits / max * 100) : 0}%"></div></div><strong>${row.commits}</strong></div>`).join("")}</div></section>
      <div class="profile-columns"><section><h2>Проекты за 30 дней</h2>${activity.repositories.map((repo) => `<a class="stat-line project-row" href="${escapeHtml(`/admin/commits?author=${id}&repository=${encodeURIComponent(repo.repository)}`)}"><span>${escapeHtml(repo.repository)}</span><strong>${repo.commits} <span aria-hidden="true">→</span></strong></a>`).join("") || '<p class="muted">Пока нет коммитов.</p>'}</section>
      <section><h2>Итог по коммитам</h2><p class="muted">ИИ описывает темы работы по доступным коммитам. Это не оценка сотрудника.</p>${url.searchParams.has("insight_error") ? '<p class="error">Не удалось создать итог. Попробуйте позже; предыдущий итог сохранён.</p>' : ""}
      ${insight ? `<p>${escapeHtml(insight.summary)}</p><small>Составлено ${date(insight.generated_at)} · на момент итога: ${insight.commit_count} коммитов за 30 дней</small><div class="evidence">${evidence.map((commit) => `<a href="${escapeHtml(commit.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(commit.message.split("\n")[0].slice(0, 95))} ↗</a>`).join("")}</div>` : '<p class="muted">Итог ещё не составлен.</p>'}
      <form method="post" action="/admin/insight"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${id}"><button data-loading-label="Составляю итог…" ${author.last_30 ? "" : "disabled"}>${insight ? "Обновить итог" : "Составить итог за 30 дней"}</button></form></section></div>
      <section><div class="section-heading"><h2>Последние коммиты</h2><a href="/admin/commits?author=${id}">Вся история →</a></div>${activity.recent.slice(0, 10).map((commit) => `<div class="recent-commit"><a href="${escapeHtml(commit.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(commit.message.split("\n")[0])}</a><small>${escapeHtml(commit.repository)} · ${date(commit.committed_at)}</small></div>`).join("") || '<p class="muted">За последние 30 дней коммитов нет.</p>'}</section>`;
    sendHtml(response, page(author.name, content, true, csrf));
    return true;
  }

  if (url.pathname === "/admin/people") {
    const all = store.authors();
    const authors = combinedAuthors(all);
    const targets = all.filter((author) => !author.merged_into);
    const content = `<h1>Сотрудники</h1><p class="muted">За последние 30 дней. Рейтинг — по коммитам; активные дни и проекты дают контекст.</p>
      <section class="people-list"><div class="people-head"><span>Сотрудник</span><span>Коммиты</span><span>Дни</span><span>Проекты</span><span>Последний</span></div><div class="people-mobile-head"><span>Сотрудник</span><span>Коммиты</span><span>Дни</span></div>${authors.map((author) => { const activity = store.authorActivity(author.id); return `<a class="people-row" href="/admin/people/${author.id}"><span class="people-person"><strong>${escapeHtml(author.name)}</strong><small>${activity.repositoryCount} ${plural(activity.repositoryCount, "проект", "проекта", "проектов")}</small></span><span>${author.last_30}</span><span>${activity.activeDays}</span><span>${activity.repositoryCount}</span><small>${date(author.last_commit)}</small></a>`; }).join("") || '<p class="muted">Пока нет сотрудников.</p>'}</section>
      <details class="management"><summary>Управление авторами</summary><p class="muted">Авторы добавляются автоматически. Скрытые не входят в сводку; объединённые учитываются как один сотрудник.</p>
      ${all.map((author) => `<article class="person"><div><a href="/admin/commits?author=${author.id}">${escapeHtml(author.name)}</a> ${author.github_login ? `<small>@${escapeHtml(author.github_login)}</small>` : ""}
      ${author.hidden ? `<small>Скрыт${author.merged_into ? " · объединён" : ""}</small>` : ""}<p>${author.commits} коммитов · за 30 дней: ${author.last_30} · последний: ${date(author.last_commit)}</p></div>
      ${author.merged_into ? `<form method="post" action="/admin/unmerge"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${author.id}"><button>Разъединить</button></form>` : `<form method="post" action="/admin/hide"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${author.id}"><input type="hidden" name="hidden" value="${author.hidden ? 0 : 1}"><button>${author.hidden ? "Показать" : "Скрыть"}</button></form>`}
      ${!author.merged_into && targets.length > 1 ? `<form method="post" action="/admin/merge"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${author.id}"><select name="target" required><option value="">Объединить с…</option>${targets.filter((target) => target.id !== author.id).map((target) => `<option value="${target.id}">${escapeHtml(target.name)}</option>`).join("")}</select><button>Объединить</button></form>` : ""}</article>`).join("") || "Пока нет авторов."}</details>`;
    sendHtml(response, page("Сотрудники", content, true, csrf));
    return true;
  }

  if (url.pathname === "/admin/commits") {
    const author = Number(url.searchParams.get("author")) || undefined;
    const authors = store.authors().filter((person) => !person.merged_into);
    const selectedAuthor = authors.find((person) => person.id === author);
    const repositories = author ? store.repositoriesByAuthor(author) : store.repositories().map((repo) => repo.full_name);
    const requestedRepository = url.searchParams.get("repository") || undefined;
    const repository = requestedRepository && repositories.includes(requestedRepository) ? requestedRepository : undefined;
    const from = validDate(url.searchParams.get("from"));
    const to = validDate(url.searchParams.get("to"));
    const currentPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const commits = store.commits({ author, repository, from, to, page: currentPage });
    const content = `${selectedAuthor ? `<a class="back-link" href="/admin/people/${selectedAuthor.id}">← ${escapeHtml(selectedAuthor.name)}</a>` : ""}<h1>История коммитов</h1>${selectedAuthor && repository ? `<p class="muted">${escapeHtml(selectedAuthor.name)} · ${escapeHtml(repository)}</p>` : ""}<form class="filters" method="get" action="/admin/commits">
      <select name="author" aria-label="Сотрудник"><option value="">Все авторы</option>${authors.map((person) => `<option value="${person.id}" ${person.id === author ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("")}</select>
      <select name="repository" aria-label="Проект"><option value="">Все проекты</option>${repositories.map((name) => `<option value="${escapeHtml(name)}" ${name === repository ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select>
      <label>С <input type="date" name="from" value="${from ?? ""}"></label><label>По <input type="date" name="to" value="${to ?? ""}"></label><button>Показать</button></form>
      <p class="muted commit-hint">Под заголовком показывается описание, если оно есть в сообщении коммита или создано ботом.</p>
      ${commits.map((commit) => `<article class="commit"><div><a href="${escapeHtml(commit.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(commit.message.split("\n")[0])}</a><p>${escapeHtml(commit.author_name)} · ${escapeHtml(commit.repository)} · ${date(commit.committed_at)} · ${escapeHtml(commit.sha.slice(0, 8))}</p>${commitDescription(commit)}</div></article>`).join("") || "Коммиты не найдены."}
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

function commitDescription(commit: CommitRow): string {
  const body = commit.message.split("\n").slice(1).join("\n").trim();
  if (commit.summary) return `<p class="commit-description">${escapeHtml(commit.summary)}</p>`;
  if (body) return `<p class="commit-description">${escapeHtml(body.slice(0, 1200))}</p>`;
  return "";
}

function loginPage(error: boolean): string {
  return page("Вход", `<div class="login"><h1>Вход в админку</h1>${error ? `<p class="error">Неверный email или пароль</p>` : ""}<form method="post" action="/admin/login"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Пароль<input name="password" type="password" autocomplete="current-password" required></label><button>Войти</button></form></div>`, false);
}

function page(title: string, content: string, authenticated: boolean, csrf = ""): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Manager Bot</title><style>${css}${mobileHeaderCss}${dashboardCss}${polishCss}${interactionCss}${responsiveFilterCss}${activityCss}</style></head><body>
    ${authenticated ? `<header><a class="brand" href="/admin">Manager Bot</a><nav><a href="/admin">Обзор</a><a href="/admin/people">Сотрудники</a><a href="/admin/commits">Коммиты</a><a href="/admin/import">Загрузка</a></nav><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="quiet" data-loading-label="Выходим…">Выйти</button></form></header>` : ""}
    <main>${content}</main><script>${interactionJs}</script></body></html>`;
}

const css = `:root{color-scheme:light dark;font-family:Inter,system-ui,sans-serif;background:#f5f7fb;color:#172033}*{box-sizing:border-box}body{margin:0}header{display:flex;align-items:center;gap:24px;padding:16px max(20px,calc((100vw - 1180px)/2));background:#fff;border-bottom:1px solid #dde3eb}header nav{display:flex;gap:20px;flex:1;flex-wrap:wrap}.brand{font-weight:750;font-size:18px}a{color:#305cb8;text-decoration:none}header a{color:inherit}a:hover{text-decoration:underline}main{max-width:1180px;margin:36px auto;padding:0 20px}h1{font-size:30px;margin:0 0 24px}h2{font-size:18px;margin:0 0 16px}p{line-height:1.5}.muted,small,.commit p,.person p{color:#647084}section,article{background:#fff;border:1px solid #e0e6ef;border-radius:14px;padding:20px;margin-bottom:18px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.cards article{display:flex;flex-direction:column;gap:14px}.cards strong{font-size:32px}.columns{display:grid;grid-template-columns:2fr 1fr;gap:18px}.chart{height:170px;display:flex;align-items:end;gap:5px;overflow:auto}.bar-wrap{height:100%;min-width:19px;flex:1;display:flex;flex-direction:column;justify-content:end;text-align:center;gap:5px}.bar{background:#4678db;border-radius:4px 4px 0 0}.bar-wrap small{font-size:9px;white-space:nowrap}.stat-line{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #eef1f5;gap:16px}.table-head,.table-row{display:grid;grid-template-columns:2fr 55px 60px 120px;gap:8px;padding:10px;border-bottom:1px solid #eef1f5}.table-head{color:#647084;font-size:12px}.person{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.person>div{flex:1;min-width:230px}.person p,.commit p{margin:5px 0 0;font-size:13px}.person form{display:flex;gap:7px}.filters{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:20px}.filters label,.login label{display:flex;flex-direction:column;gap:6px}input,select,button{font:inherit;border-radius:8px;border:1px solid #cbd5e1;padding:9px 12px;background:#fff;color:inherit}button{background:#305cb8;color:#fff;border-color:#305cb8;cursor:pointer}button.quiet{background:transparent;color:inherit;border:0}.login{max-width:390px;margin:12vh auto;background:#fff;padding:30px;border-radius:16px;border:1px solid #e0e6ef}.login form{display:grid;gap:18px}.login input{width:100%}.error{color:#bf3030}.pagination{display:flex;gap:18px;margin:20px 0}@media(max-width:800px){header{align-items:flex-start;flex-wrap:wrap}header nav{order:3;width:100%}.cards{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}.table-head,.table-row{grid-template-columns:2fr 45px 55px 95px}}@media(max-width:480px){.cards{grid-template-columns:1fr 1fr}.table-head,.table-row{font-size:12px;grid-template-columns:1.5fr 35px 45px 75px}h1{font-size:25px}}@media(prefers-color-scheme:dark){:root{background:#111827;color:#edf2f8}header,section,article,.login{background:#1c2635;border-color:#334155}.muted,small,.commit p,.person p,.table-head{color:#a5b4c7}a{color:#92b5ff}header a{color:inherit}input,select{background:#111827;border-color:#475569}button{background:#638cf0;border-color:#638cf0;color:#0e1728}.stat-line,.table-head,.table-row{border-color:#334155}.bar{background:#7ca6ff}}`;
const mobileHeaderCss = `@media(max-width:800px){header{display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px}header nav{grid-column:1/-1;grid-row:2;width:auto;display:flex;gap:16px}header form{grid-column:2;grid-row:1}.person form{max-width:100%}}`;
const dashboardCss = `.page-title,.section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.page-title h1{margin-bottom:4px}.page-title{margin-bottom:22px}.page-title p{margin:0}.notice{padding:12px 16px;border:1px solid #d2b86d;border-radius:10px;background:#fff7df;color:#5d4611}.leader-row{display:grid;grid-template-columns:36px minmax(0,1fr) 65px 80px;align-items:center;gap:12px;padding:14px 2px;border-top:1px solid #eef1f5;color:inherit}.leader-row:hover,.people-row:hover{background:#f5f8fd;text-decoration:none}.rank{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:#e9efff;color:#305cb8;font-weight:700}.leader-name{display:flex;flex-direction:column;gap:3px;min-width:0}.leader-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.leader-name small{font-size:12px}.leader-count{text-align:right;font-size:20px}.leader-label{color:#647084;font-size:13px}.section-link{display:block;margin-top:16px}.people-list{padding:8px 20px}.people-head,.people-row{display:grid;grid-template-columns:minmax(130px,2fr) repeat(3,minmax(60px,1fr)) minmax(130px,1.3fr);gap:12px;align-items:center;padding:13px 8px;border-bottom:1px solid #eef1f5}.people-head{color:#647084;font-size:12px}.people-row{color:inherit}.people-row span,.people-head span:not(:first-child){text-align:right}.people-row small{text-align:right}.management{margin:20px 0}.management summary{cursor:pointer;font-weight:650;padding:14px 0}.management .person{margin-bottom:10px}.back-link{display:inline-block;margin-bottom:14px}.profile-columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}.profile-columns section{min-width:0}.evidence{display:flex;flex-direction:column;gap:8px;margin:12px 0 18px}.recent-commit{display:flex;flex-direction:column;gap:4px;padding:12px 0;border-top:1px solid #eef1f5}.recent-commit a{overflow-wrap:anywhere}.profile-columns .stat-line span{overflow-wrap:anywhere}button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:800px){.profile-columns{grid-template-columns:1fr}}@media(max-width:600px){.people-head{display:none}.people-row{grid-template-columns:minmax(0,1fr) 56px 46px;gap:5px}.people-row span:nth-of-type(3),.people-row small{display:none}.people-row strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.people-list:before{content:'Сотрудник                                      Коммиты    Дни';display:block;white-space:pre;font-size:10px;color:#647084;overflow:hidden}.leader-row{grid-template-columns:30px minmax(0,1fr) 48px}.leader-label{display:none}.leader-count{font-size:18px}.page-title{align-items:flex-start}.page-title>a{font-size:13px;white-space:nowrap}}@media(prefers-color-scheme:dark){.notice{background:#3c3320;border-color:#846c3a;color:#f5deb0}.leader-row,.people-head,.people-row,.recent-commit{border-color:#334155}.leader-row:hover,.people-row:hover{background:#25344a}.rank{background:#263c68;color:#b8cbff}.leader-label{color:#a5b4c7}}`;
const polishCss = `.people-person{display:flex;flex-direction:column;gap:3px;min-width:0;text-align:left!important}.people-person strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.people-person small{display:none;text-align:left}.people-row>span:nth-child(4){text-align:right}.people-mobile-head{display:none}@media(max-width:600px){.people-person small{display:block;font-size:11px}.people-row>span:nth-child(3){display:block}.people-row>span:nth-child(4),.people-row>small{display:none}.people-list:before,.people-list:after{content:none}.people-mobile-head{display:grid;grid-template-columns:minmax(0,1fr) 56px 46px;gap:5px;padding:6px 8px;color:#647084;font-size:10px}.people-mobile-head span:not(:first-child){text-align:right}.chart{gap:2px;overflow:visible}.bar-wrap{min-width:0}.bar-wrap small{font-size:7px}.bar{min-width:1px}}`;
const interactionCss = `.project-row{color:inherit;cursor:pointer;align-items:center;border-radius:8px;padding:9px 10px;margin:0 -10px;transition:background-color .15s ease,color .15s ease}.project-row strong{white-space:nowrap}.project-row:hover{background:#eef3fd;color:#305cb8;text-decoration:none}.project-row:focus-visible,a:focus-visible,button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #4678db;outline-offset:2px}.commit-description{white-space:pre-line;overflow-wrap:anywhere;margin-top:10px!important;line-height:1.5}.is-loading{display:inline-flex;align-items:center;justify-content:center;gap:8px;opacity:.8;cursor:progress!important}.is-loading:before{content:'';width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite;flex:none}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.is-loading:before{animation:none}}@media(prefers-color-scheme:dark){.project-row:hover{background:#263c58;color:#b8cbff}}`;
const responsiveFilterCss = `.commit-hint{font-size:13px;margin:-6px 0 18px}@media(max-width:600px){.filters select{width:100%;min-width:0}.filters label{flex:1 1 130px;min-width:0}.filters label input{width:100%;min-width:0}.filters button{min-width:120px}}`;
const activityCss = `.activity-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:22px}.activity-heading h2{margin-bottom:4px}.last-commit{display:flex;flex-direction:column;gap:4px;text-align:right;white-space:nowrap}.last-commit span{font-size:12px;color:#647084}.last-commit strong{font-size:16px}.activity-days{display:grid;gap:12px}.activity-day{display:grid;grid-template-columns:140px minmax(0,1fr) 64px;align-items:center;gap:14px;font-size:14px}.activity-day strong{text-align:right;font-size:16px}.activity-track{height:13px;border-radius:7px;background:#e9eef6;overflow:hidden}.activity-fill{height:100%;border-radius:7px;background:#4678db}@media(max-width:600px){.activity-heading{flex-wrap:wrap;gap:14px}.last-commit{text-align:left}.activity-day{grid-template-columns:90px minmax(0,1fr) 35px;gap:8px;font-size:12px}.activity-day strong{font-size:14px}}@media(prefers-color-scheme:dark){.last-commit span{color:#a5b4c7}.activity-track{background:#344155}.activity-fill{background:#7ca6ff}.project-row,.project-row:visited{color:#edf2f8}}`;
const interactionJs = `document.addEventListener('submit',function(event){const form=event.target;if(!(form instanceof HTMLFormElement))return;if(form.dataset.submitting==='1'){event.preventDefault();return}const button=event.submitter instanceof HTMLButtonElement?event.submitter:form.querySelector('button');if(!button)return;form.dataset.submitting='1';button.dataset.originalLabel=button.textContent||'';button.textContent=button.dataset.loadingLabel||(form.action.endsWith('/login')?'Входим…':form.method.toLowerCase()==='get'?'Показываю…':'Сохраняю…');button.classList.add('is-loading');button.setAttribute('aria-busy','true');button.disabled=true});document.addEventListener('change',function(event){const select=event.target;if(!(select instanceof HTMLSelectElement)||select.name!=='author'||!select.form||!select.form.action.endsWith('/commits'))return;const repository=select.form.elements.namedItem('repository');if(repository instanceof HTMLSelectElement)repository.value='';select.form.requestSubmit()});window.addEventListener('pageshow',function(){document.querySelectorAll('form[data-submitting="1"]').forEach(function(form){form.dataset.submitting='0';form.querySelectorAll('button.is-loading').forEach(function(button){button.textContent=button.dataset.originalLabel||button.textContent;button.disabled=false;button.classList.remove('is-loading');button.removeAttribute('aria-busy')})})});`;

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
function dayLabel(day: string): string { return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`)); }
function plural(value: number, one: string, few: string, many: string): string { const n = Math.abs(value) % 100; const digit = n % 10; return n >= 11 && n <= 14 ? many : digit === 1 ? one : digit >= 2 && digit <= 4 ? few : many; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function sendHtml(response: ServerResponse, html: string, status = 200): void { response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html); }
function redirect(response: ServerResponse, location: string): void { response.writeHead(303, { Location: location }).end(); }
