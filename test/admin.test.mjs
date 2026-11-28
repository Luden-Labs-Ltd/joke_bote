import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes, scryptSync } from "node:crypto";
import { CommitStore } from "../dist/commit-store.js";
import { handleAdmin } from "../dist/admin.js";
import { runHistory } from "../dist/github-history.js";
import { generateAuthorInsight } from "../dist/author-insight.js";
import { monthDays, nextMonth } from "../dist/month.js";

test("calendar months include their own first and last days in Minsk", () => {
  const folder = mkdtempSync(join(tmpdir(), "manager-month-"));
  try {
    const store = new CommitStore(join(folder, "commits.sqlite"));
    const insert = (sha, date) => store.upsertCommit({ repository: "org/app", sha: sha.repeat(40), message: sha, committedAt: date, authorName: "Alice", authorLogin: "alice", url: `https://github.com/org/app/commit/${sha}` });
    insert("a", "2026-10-31T20:59:59Z");
    insert("b", "2026-10-31T21:00:00Z");
    insert("c", "2026-11-30T20:59:59Z");
    insert("d", "2026-11-30T21:00:00Z");
    const id = store.authors("2026-11")[0].id;
    assert.equal(store.authors("2026-11")[0].month_commits, 2);
    assert.deepEqual(store.authorActivity(id, "2026-11").days.map((row) => row.day), ["2026-11-01", "2026-11-30"]);
    assert.equal(store.trend("2026-11").reduce((sum, row) => sum + row.commits, 0), 2);
    assert.equal(store.authors("2026-10")[0].month_commits, 1);
    assert.equal(store.authors("2026-12")[0].month_commits, 1);
    assert.equal(monthDays("2024-02").length, 29);
    assert.equal(nextMonth("2026-12"), "2027-01");
    store.saveAuthorInsight(id, "2026-11", "November", ["b".repeat(40)], 2);
    assert.equal(store.authorInsight(id, "2026-11")?.summary, "November");
    assert.equal(store.authorInsight(id, "2026-10"), undefined);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("commit storage deduplicates pushes, keeps authors and aggregates merged authors", () => {
  const folder = mkdtempSync(join(tmpdir(), "manager-bot-"));
  try {
    const store = new CommitStore(join(folder, "commits.sqlite"));
    const first = { repository: "Luden-Labs-Ltd/app", sha: "a".repeat(40), message: "First", committedAt: new Date().toISOString(), authorName: "Alice", authorLogin: "alice", url: "https://github.com/Luden-Labs-Ltd/app/commit/a" };
    assert.equal(store.upsertCommit(first), true);
    assert.equal(store.upsertCommit(first), false);
    assert.equal(store.markWebhookSeen(first.repository, first.sha), true);
    assert.equal(store.markWebhookSeen(first.repository, first.sha), false);
    store.upsertCommit({ ...first, sha: "b".repeat(40), authorName: "Alice Work", authorLogin: "alice-work" });
    const authors = store.authors();
    assert.equal(authors.length, 2);
    store.mergeAuthor(authors[1].id, authors[0].id);
    assert.equal(store.commits({ author: authors[0].id }).length, 2);
    store.setHidden(authors[0].id, true);
    assert.equal(store.trend(new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7)).reduce((sum, row) => sum + row.commits, 0), 0);
    store.unmergeAuthor(authors[1].id);
    assert.equal(store.authors().find((author) => author.id === authors[1].id).merged_into, null);
    store.upsertCommit({ ...first, sha: "f".repeat(40), authorName: "Alice Home", authorLogin: "alice-home" });
    const third = store.authors().find((author) => author.github_login === "alice-home");
    store.mergeAuthor(third.id, authors[1].id);
    store.mergeAuthor(authors[1].id, authors[0].id);
    assert.equal(store.commits({ author: authors[0].id }).length, 3);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("admin requires login and CSRF for changes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "manager-admin-"));
  const salt = randomBytes(16);
  const config = { email: "admin@example.com", passwordHash: `${salt.toString("hex")}:${scryptSync("test-password", salt, 64).toString("hex")}`, sessionSecret: randomBytes(32).toString("hex") };
  const store = new CommitStore(join(folder, "commits.sqlite"));
  store.upsertCommit({ repository: "Luden-Labs-Ltd/app", sha: "c".repeat(40), message: "A commit", committedAt: new Date().toISOString(), authorName: "Alice", authorLogin: "alice", url: "https://github.com/Luden-Labs-Ltd/app/commit/c" });
  const server = createServer((request, response) => { void handleAdmin(request, response, store, config); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const protectedPage = await fetch(`${base}/admin`, { redirect: "manual" });
    assert.equal(protectedPage.status, 303);
    const login = await fetch(`${base}/admin/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: config.email, password: "test-password" }) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const page = await fetch(`${base}/admin/people`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Alice/);
    const badPost = await fetch(`${base}/admin/hide`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id: String(store.authors()[0].id), hidden: "1" }) });
    assert.equal(badPost.status, 403);
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
    const goodPost = await fetch(`${base}/admin/hide`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, id: String(store.authors()[0].id), hidden: "1" }) });
    assert.equal(goodPost.status, 303);
    assert.equal(store.authors()[0].hidden, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("history scans each branch and deduplicates shared commits", async () => {
  const folder = mkdtempSync(join(tmpdir(), "manager-history-"));
  const store = new CommitStore(join(folder, "commits.sqlite"));
  const originalFetch = globalThis.fetch;
  const sha = "e".repeat(40);
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    paths.push(url.pathname + url.search);
    let body;
    if (url.pathname === "/orgs/Luden-Labs-Ltd/repos") body = [{ full_name: "Luden-Labs-Ltd/demo" }];
    else if (url.pathname.endsWith("/branches")) body = [{ name: "main", commit: { sha } }, { name: "dev", commit: { sha } }];
    else if (url.pathname.endsWith("/commits")) body = [{ sha, html_url: `https://github.com/Luden-Labs-Ltd/demo/commit/${sha}`, author: { login: "alice" }, commit: { message: "Shared commit", author: { name: "Alice", email: "alice@example.com", date: new Date().toISOString() }, committer: { date: new Date().toISOString() } } }];
    else throw new Error(`Unexpected URL ${url}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await runHistory(store, "fake-token", "Luden-Labs-Ltd");
    assert.equal(store.commits({}).length, 1);
    assert.equal(store.branches().filter((branch) => branch.status === "complete").length, 2);
    assert.equal(store.repositories()[0].status, "complete");
    assert.ok(paths.some((path) => path.includes(`sha=${sha}`)));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("dashboard ranks merged authors and profile counts active days and projects", async () => {
  const folder = mkdtempSync(join(tmpdir(), "manager-ranking-"));
  const store = new CommitStore(join(folder, "commits.sqlite"));
  const config = { email: "admin@example.com", passwordHash: "unused:unused", sessionSecret: randomBytes(32).toString("hex") };
  const server = createServer((request, response) => { void handleAdmin(request, response, store, config); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const now = new Date().toISOString();
    const insert = (sha, name, login, repository, message = `${name} change`) => store.upsertCommit({ repository, sha: sha.repeat(40), message, committedAt: now, authorName: name, authorLogin: login, url: `https://github.com/${repository}/commit/${sha}` });
    insert("a", "Alice", "alice", "org/app");
    insert("b", "Alice Work", "alice-work", "org/api");
    insert("e", "Alice Work", "alice-work", "org/api", "Refactor auth\n\nUpdated token validation");
    insert("c", "Bob", "bob", "org/other");
    insert("d", "Hidden Bot", "bot", "org/app");
    store.setSummary("org/api", "b".repeat(40), "Изменена авторизация проекта.");
    store.setCommitStats("org/api", "b".repeat(40), { additions: 42, deletions: 7, changedFiles: 3 });
    const people = store.authors();
    const alice = people.find((person) => person.github_login === "alice");
    store.mergeAuthor(people.find((person) => person.github_login === "alice-work").id, alice.id);
    store.setHidden(people.find((person) => person.github_login === "bot").id, true);
    const activity = store.authorActivity(alice.id);
    assert.equal(activity.activeDays, 1);
    assert.equal(activity.repositoryCount, 2);
    assert.equal(activity.recent.length, 3);
    assert.equal(activity.recent.find((commit) => commit.sha === "b".repeat(40)).additions, 42);
    assert.equal(store.recentCommitsNeedingStats(alice.id).length, 2);
    const cookie = `admin_session=${Date.now() + 100_000}.nonce`;
    const { createHmac } = await import("node:crypto");
    const signed = `${cookie}.${createHmac("sha256", config.sessionSecret).update(cookie.slice(14)).digest("hex")}`;
    const base = `http://127.0.0.1:${server.address().port}`;
    const home = await (await fetch(`${base}/admin`, { headers: { Cookie: signed } })).text();
    assert.match(home, /Топ сотрудников/);
    assert.match(home, /1 активный день/);
    assert.ok(home.indexOf("Alice</strong>") < home.indexOf("Bob</strong>"));
    assert.doesNotMatch(home, /Hidden Bot/);
    const profile = await (await fetch(`${base}/admin/people/${alice.id}`, { headers: { Cookie: signed } })).text();
    assert.match(profile, /Активных дней/);
    assert.match(profile, /org\/api/);
    assert.match(profile, /Все активные дни ·/);
    assert.match(profile, new RegExp(`/admin/commits\\?author=${alice.id}&amp;from=\\d{4}-\\d{2}-\\d{2}&amp;to=\\d{4}-\\d{2}-\\d{2}`));
    assert.match(profile, /3 файла · <span>\+42<\/span> \/ <span>−7<\/span> строк/);
    assert.match(profile, /Updated token validation/);
    assert.match(profile, new RegExp(`/admin/commits\\?author=${alice.id}&amp;repository=org%2Fapi`));
    const historyResponse = await fetch(`${base}/admin/commits?author=${alice.id}&repository=org%2Fapi`, { headers: { Cookie: signed } });
    const history = await historyResponse.text();
    assert.match(history, /Изменена авторизация проекта/);
    assert.match(history, /Updated token validation/);
    assert.match(history, /\+42/);
    assert.match(history, /<option value="org\/api" selected>/);
    assert.match(history, /<option value="org\/app"/);
    assert.doesNotMatch(history, /<option value="org\/other"/);
    assert.doesNotMatch(history, /Bob change/);
    assert.match(historyResponse.headers.get("content-security-policy"), /script-src 'sha256-/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("failed insight generation leaves the saved summary intact", async () => {
  const folder = mkdtempSync(join(tmpdir(), "manager-insight-"));
  const store = new CommitStore(join(folder, "commits.sqlite"));
  const originalFetch = globalThis.fetch;
  try {
    store.upsertCommit({ repository: "org/app", sha: "e".repeat(40), message: "Fix auth", committedAt: new Date().toISOString(), authorName: "Alice", authorLogin: "alice", url: "https://github.com/org/app/commit/e" });
    const id = store.authors()[0].id;
    store.saveAuthorInsight(id, new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7), "Предыдущий итог", ["e".repeat(40)], 1);
    globalThis.fetch = async () => new Response("failure", { status: 503 });
    await assert.rejects(generateAuthorInsight("Alice", store.authorActivity(id), "key", "model"), /503/);
    assert.equal(store.authorInsight(id).summary, "Предыдущий итог");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("employee profile loads and caches size of historical commits", async () => {
  const folder = mkdtempSync(join(tmpdir(), "manager-size-"));
  const store = new CommitStore(join(folder, "commits.sqlite"));
  const config = { email: "admin@example.com", passwordHash: "unused:unused", sessionSecret: randomBytes(32).toString("hex"), githubApiToken: "fake-token" };
  const sha = "a".repeat(40);
  store.upsertCommit({ repository: "org/app", sha, message: "Fix search\n\nHandle empty results", committedAt: new Date().toISOString(), authorName: "Alice", authorLogin: "alice", url: `https://github.com/org/app/commit/${sha}` });
  store.upsertCommit({ repository: "org/app", sha: "b".repeat(40), message: "Old release", committedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), authorName: "Alice", authorLogin: "alice", url: `https://github.com/org/app/commit/${"b".repeat(40)}` });
  const server = createServer((request, response) => { void handleAdmin(request, response, store, config); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const originalFetch = globalThis.fetch;
  let githubCalls = 0;
  globalThis.fetch = async (input, options) => {
    if (String(input).startsWith("https://api.github.com/")) {
      githubCalls += 1;
      assert.match(String(input), /org\/app\/commits\/[ab]{40}/);
      return new Response(JSON.stringify({ stats: { additions: 124, deletions: 9 }, files: [{}, {}] }), { status: 200 });
    }
    return originalFetch(input, options);
  };
  try {
    const { createHmac } = await import("node:crypto");
    const session = `${Date.now() + 100_000}.nonce`;
    const cookie = `admin_session=${session}.${createHmac("sha256", config.sessionSecret).update(session).digest("hex")}`;
    const url = `http://127.0.0.1:${server.address().port}/admin/people/${store.authors()[0].id}`;
    const first = await (await fetch(url, { headers: { Cookie: cookie } })).text();
    assert.match(first, /2 файла · <span>\+124<\/span> \/ <span>−9<\/span> строк/);
    assert.match(first, /Handle empty results/);
    await fetch(url, { headers: { Cookie: cookie } });
    assert.equal(githubCalls, 1);
    const history = await (await fetch(`http://127.0.0.1:${server.address().port}/admin/commits?author=${store.authors()[0].id}`, { headers: { Cookie: cookie } })).text();
    assert.match(history, /Old release/);
    assert.match(history, /2 файла · <span>\+124<\/span> \/ <span>−9<\/span> строк/);
    assert.equal(githubCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("insight accepts only evidence from supplied commits", async () => {
  const folder = mkdtempSync(join(tmpdir(), "manager-insight-evidence-"));
  const store = new CommitStore(join(folder, "commits.sqlite"));
  const originalFetch = globalThis.fetch;
  try {
    const sha = "f".repeat(40);
    store.upsertCommit({ repository: "org/app", sha, message: "Fix auth", committedAt: new Date().toISOString(), authorName: "Alice", authorLogin: "alice", url: "https://github.com/org/app/commit/f" });
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.match(request.contents[0].parts[0].text, /Не оценивай эффективность/);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "Исправляла авторизацию в org/app.", evidence: ["0".repeat(12), sha.slice(0, 12)] }) }] } }] }), { status: 200 });
    };
    const insight = await generateAuthorInsight("Alice", store.authorActivity(store.authors()[0].id), "key", "model");
    assert.equal(insight.summary, "Исправляла авторизацию в org/app.");
    assert.deepEqual(insight.evidence, [sha]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(folder, { recursive: true, force: true });
  }
});
