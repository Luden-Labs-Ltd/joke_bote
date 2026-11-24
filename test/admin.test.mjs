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
    assert.equal(store.trend(30).reduce((sum, row) => sum + row.commits, 0), 0);
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
