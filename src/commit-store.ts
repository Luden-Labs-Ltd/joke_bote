import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { currentMonth, nextMonth } from "./month.js";
import { initialProjectDescriptions, initialProjectForRepository, projectSeeds } from "./project-seeds.js";

export type CommitInput = {
  repository: string;
  sha: string;
  message: string;
  committedAt: string;
  authorName: string;
  authorEmail?: string | null;
  authorLogin?: string | null;
  url: string;
  summary?: string | null;
};

export type Author = { id: number; name: string; github_login: string | null; hidden: number; merged_into: number | null; commits: number; last_commit: string | null; month_commits: number };
export type CommitRow = { repository: string; sha: string; message: string; committed_at: string; url: string; summary: string | null; author_id: number; author_name: string; additions: number | null; deletions: number | null; changed_files: number | null };
export type Repository = { full_name: string; status: string; error: string | null; updated_at: string | null; commit_count: number };
export type AuthorActivity = { activeDays: number; repositoryCount: number; days: { day: string; commits: number }[]; repositories: { repository: string; commits: number }[]; recent: CommitRow[] };
export type AuthorInsight = { summary: string; evidence: string[]; generated_at: string; commit_count: number };
export type Project = { id: number; name: string; description: string; draft: string; tracker_url: string; repositories: string[]; commits: number; contributors: number; last_commit: string | null };

export class CommitStore {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authors (
        id INTEGER PRIMARY KEY, identity_key TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        github_login TEXT, hidden INTEGER NOT NULL DEFAULT 0,
        merged_into INTEGER REFERENCES authors(id)
      );
      CREATE TABLE IF NOT EXISTS repositories (
        full_name TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
        error TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS commits (
        repository TEXT NOT NULL REFERENCES repositories(full_name), sha TEXT NOT NULL,
        author_id INTEGER NOT NULL REFERENCES authors(id), message TEXT NOT NULL,
        committed_at TEXT NOT NULL, url TEXT NOT NULL, summary TEXT,
        PRIMARY KEY(repository, sha)
      );
      CREATE INDEX IF NOT EXISTS commits_date ON commits(committed_at);
      CREATE INDEX IF NOT EXISTS commits_author_date ON commits(author_id, committed_at);
      CREATE TABLE IF NOT EXISTS webhook_seen (
        repository TEXT NOT NULL, sha TEXT NOT NULL,
        PRIMARY KEY(repository, sha)
      );
      CREATE TABLE IF NOT EXISTS backfill (
        repository TEXT NOT NULL REFERENCES repositories(full_name), branch TEXT NOT NULL,
        head_sha TEXT NOT NULL, page INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending',
        error TEXT, PRIMARY KEY(repository, branch)
      );
      CREATE TABLE IF NOT EXISTS author_insights (
        author_id INTEGER PRIMARY KEY REFERENCES authors(id), summary TEXT NOT NULL,
        evidence TEXT NOT NULL, generated_at TEXT NOT NULL, commit_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS monthly_author_insights (
        author_id INTEGER NOT NULL REFERENCES authors(id), month TEXT NOT NULL, summary TEXT NOT NULL,
        evidence TEXT NOT NULL, generated_at TEXT NOT NULL, commit_count INTEGER NOT NULL,
        PRIMARY KEY(author_id, month)
      );
      CREATE TABLE IF NOT EXISTS commit_stats (
        repository TEXT NOT NULL, sha TEXT NOT NULL, additions INTEGER, deletions INTEGER,
        changed_files INTEGER, checked_at TEXT NOT NULL,
        PRIMARY KEY(repository, sha), FOREIGN KEY(repository, sha) REFERENCES commits(repository, sha)
      );
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        draft TEXT NOT NULL DEFAULT '', tracker_url TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS project_repositories (
        repository TEXT PRIMARY KEY REFERENCES repositories(full_name), project_id INTEGER NOT NULL REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const seed = this.db.prepare("INSERT OR IGNORE INTO projects(name, tracker_url) VALUES (?, ?)");
    for (const [name, trackerId] of projectSeeds) seed.run(name, `https://tracker.luden-labs.com/project/projects/${trackerId}/issues/`);
    if (!this.db.prepare("SELECT 1 FROM catalog_meta WHERE key = 'initial_descriptions'").get()) {
      const describe = this.db.prepare("UPDATE projects SET description = ? WHERE name = ? AND description = '' AND draft = ''");
      for (const [name, description] of Object.entries(initialProjectDescriptions)) describe.run(description, name);
      this.db.prepare("INSERT INTO catalog_meta(key, value) VALUES ('initial_descriptions', 'done')").run();
    }
    if (!this.db.prepare("SELECT 1 FROM catalog_meta WHERE key = 'initial_descriptions_v2'").get()) {
      const describe = this.db.prepare("UPDATE projects SET description = ? WHERE name = ? AND description = '' AND draft = ''");
      for (const name of ["ship", "Enola"]) describe.run(initialProjectDescriptions[name], name);
      this.db.prepare("INSERT INTO catalog_meta(key, value) VALUES ('initial_descriptions_v2', 'done')").run();
    }
    if (!this.db.prepare("SELECT 1 FROM catalog_meta WHERE key = 'initial_mapping'").get()) {
      for (const repo of this.repositories()) this.assignInitialProject(repo.full_name);
      this.db.prepare("INSERT INTO catalog_meta(key, value) VALUES ('initial_mapping', 'done')").run();
    }
  }

  addRepository(name: string): void {
    const inserted = this.db.prepare("INSERT OR IGNORE INTO repositories(full_name) VALUES (?)").run(name);
    if (inserted.changes) this.assignInitialProject(name);
  }

  private assignInitialProject(repository: string): void {
    const name = initialProjectForRepository(repository);
    if (!name) return;
    this.db.prepare(`INSERT OR IGNORE INTO project_repositories(repository, project_id)
      SELECT ?, id FROM projects WHERE name = ?`).run(repository, name);
  }

  projects(month = currentMonth()): Project[] {
    const rows = this.db.prepare(`SELECT p.*, COUNT(DISTINCT pr.repository) AS repository_count,
      COUNT(c.sha) AS commits, COUNT(DISTINCT c.author_id) AS contributors, MAX(c.committed_at) AS last_commit
      FROM projects p LEFT JOIN project_repositories pr ON pr.project_id = p.id
      LEFT JOIN commits c ON c.repository = pr.repository AND date(c.committed_at, '+3 hours') >= ? AND date(c.committed_at, '+3 hours') < ?
      GROUP BY p.id ORDER BY commits DESC, p.name COLLATE NOCASE`).all(`${month}-01`, `${nextMonth(month)}-01`) as (Omit<Project, "repositories"> & { repository_count: number })[];
    const repositoryRows = this.db.prepare("SELECT project_id, repository FROM project_repositories ORDER BY repository").all() as { project_id: number; repository: string }[];
    return rows.map((row) => ({ ...row, repositories: repositoryRows.filter((entry) => entry.project_id === row.id).map((entry) => entry.repository) }));
  }

  unassignedRepositories(): string[] {
    return this.db.prepare(`SELECT r.full_name FROM repositories r LEFT JOIN project_repositories pr ON pr.repository = r.full_name
      WHERE pr.repository IS NULL ORDER BY r.full_name`).all().map((row) => (row as { full_name: string }).full_name);
  }

  createProject(name: string, trackerUrl = ""): number {
    const result = this.db.prepare("INSERT INTO projects(name, tracker_url) VALUES (?, ?)").run(name.trim(), trackerUrl.trim());
    return Number(result.lastInsertRowid);
  }

  updateProject(id: number, name: string, description: string, trackerUrl: string): void {
    this.db.prepare("UPDATE projects SET name = ?, description = ?, tracker_url = ?, draft = '' WHERE id = ?")
      .run(name.trim(), description.trim(), trackerUrl.trim(), id);
  }

  saveProjectDraft(id: number, draft: string): void {
    this.db.prepare("UPDATE projects SET draft = ? WHERE id = ?").run(draft.trim(), id);
  }

  publishProjectDraft(id: number): void {
    this.db.prepare("UPDATE projects SET description = draft, draft = '' WHERE id = ? AND draft != ''").run(id);
  }

  assignRepository(repository: string, projectId: number | null): void {
    if (!this.hasRepository(repository)) throw new Error("Репозиторий не найден");
    if (projectId !== null && !this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error("Проект не найден");
    if (projectId === null) this.db.prepare("DELETE FROM project_repositories WHERE repository = ?").run(repository);
    else this.db.prepare("INSERT INTO project_repositories(repository, project_id) VALUES (?, ?) ON CONFLICT(repository) DO UPDATE SET project_id = excluded.project_id").run(repository, projectId);
  }

  hasRepository(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM repositories WHERE full_name = ?").get(name));
  }

  addBranch(repository: string, branch: string, headSha: string): void {
    this.addRepository(repository);
    this.db.prepare("INSERT OR IGNORE INTO backfill(repository, branch, head_sha) VALUES (?, ?, ?)").run(repository, branch, headSha);
  }

  pendingBranches(): { repository: string; branch: string; head_sha: string; page: number }[] {
    return this.db.prepare("SELECT repository, branch, head_sha, page FROM backfill WHERE status != 'complete' ORDER BY repository, branch").all() as { repository: string; branch: string; head_sha: string; page: number }[];
  }

  setBranch(repository: string, branch: string, page: number, status: string, error: string | null = null): void {
    this.db.prepare("UPDATE backfill SET page = ?, status = ?, error = ? WHERE repository = ? AND branch = ?").run(page, status, error, repository, branch);
    this.db.prepare("UPDATE repositories SET status = ?, error = ?, updated_at = datetime('now') WHERE full_name = ?")
      .run(status === "error" ? "error" : status === "complete" ? "loading" : status, error, repository);
    if (status === "complete") {
      this.db.prepare("UPDATE repositories SET status = 'complete' WHERE full_name = ? AND NOT EXISTS (SELECT 1 FROM backfill WHERE repository = ? AND status != 'complete')").run(repository, repository);
    }
  }

  setRepositoryError(repository: string, error: string): void {
    this.addRepository(repository);
    this.db.prepare("UPDATE repositories SET status = 'error', error = ?, updated_at = datetime('now') WHERE full_name = ?").run(error, repository);
  }

  hasCommit(repository: string, sha: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM commits WHERE repository = ? AND sha = ?").get(repository, sha));
  }

  markWebhookSeen(repository: string, sha: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO webhook_seen(repository, sha) VALUES (?, ?)").run(repository, sha).changes > 0;
  }

  upsertCommit(input: CommitInput): boolean {
    return this.db.transaction(() => {
      this.addRepository(input.repository);
      const key = input.authorLogin ? `github:${input.authorLogin.toLowerCase()}` : input.authorEmail ? `email:${input.authorEmail.toLowerCase()}` : `name:${input.authorName.toLowerCase()}`;
      this.db.prepare("INSERT OR IGNORE INTO authors(identity_key, name, github_login) VALUES (?, ?, ?)").run(key, input.authorName, input.authorLogin ?? null);
      const author = this.db.prepare("SELECT id FROM authors WHERE identity_key = ?").get(key) as { id: number };
      const result = this.db.prepare(`INSERT OR IGNORE INTO commits(repository, sha, author_id, message, committed_at, url, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.repository, input.sha, author.id, input.message, input.committedAt, input.url, input.summary ?? null);
      if (input.summary) this.db.prepare("UPDATE commits SET summary = ? WHERE repository = ? AND sha = ?").run(input.summary, input.repository, input.sha);
      return result.changes > 0;
    })();
  }

  setSummary(repository: string, sha: string, summary: string): void {
    this.db.prepare("UPDATE commits SET summary = ? WHERE repository = ? AND sha = ?").run(summary, repository, sha);
  }

  setCommitStats(repository: string, sha: string, stats: { additions: number; deletions: number; changedFiles: number | null } | null): void {
    this.db.prepare(`INSERT INTO commit_stats(repository, sha, additions, deletions, changed_files, checked_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(repository, sha) DO UPDATE SET additions = excluded.additions, deletions = excluded.deletions,
      changed_files = excluded.changed_files, checked_at = excluded.checked_at`)
      .run(repository, sha, stats?.additions ?? null, stats?.deletions ?? null, stats?.changedFiles ?? null);
  }

  recentCommitsNeedingStats(id: number, month = currentMonth(), limit = 10): { repository: string; sha: string }[] {
    return this.db.prepare(`SELECT recent.repository, recent.sha FROM (SELECT c.repository, c.sha FROM commits c JOIN authors a ON a.id = c.author_id
      WHERE (a.id = ? OR a.merged_into = ?) AND date(c.committed_at, '+3 hours') >= ? AND date(c.committed_at, '+3 hours') < ?
      ORDER BY c.committed_at DESC LIMIT ?) recent
      LEFT JOIN commit_stats s ON s.repository = recent.repository AND s.sha = recent.sha
      WHERE s.checked_at IS NULL OR (s.additions IS NULL AND datetime(s.checked_at) < datetime('now', '-1 hour'))`)
      .all(id, id, `${month}-01`, `${nextMonth(month)}-01`, limit) as { repository: string; sha: string }[];
  }

  commitsNeedingStats(commits: CommitRow[]): { repository: string; sha: string }[] {
    const lookup = this.db.prepare("SELECT additions, checked_at FROM commit_stats WHERE repository = ? AND sha = ?");
    const retryBefore = Date.now() - 60 * 60 * 1000;
    return commits.filter((commit) => {
      const stats = lookup.get(commit.repository, commit.sha) as { additions: number | null; checked_at: string } | undefined;
      return !stats || (stats.additions === null && Date.parse(stats.checked_at) < retryBefore);
    }).map(({ repository, sha }) => ({ repository, sha }));
  }

  authors(month = currentMonth()): Author[] {
    const next = nextMonth(month);
    return this.db.prepare(`SELECT a.id, a.name, a.github_login, a.hidden, a.merged_into,
      COUNT(c.sha) AS commits, MAX(c.committed_at) AS last_commit,
      SUM(CASE WHEN date(c.committed_at, '+3 hours') >= ? AND date(c.committed_at, '+3 hours') < ? THEN 1 ELSE 0 END) AS month_commits
      FROM authors a LEFT JOIN commits c ON c.author_id = a.id
      GROUP BY a.id ORDER BY month_commits DESC, a.name`).all(`${month}-01`, `${next}-01`) as Author[];
  }

  authorActivity(id: number, month = currentMonth()): AuthorActivity {
    const where = "(a.id = ? OR a.merged_into = ?) AND date(c.committed_at, '+3 hours') >= ? AND date(c.committed_at, '+3 hours') < ?";
    const args = [id, id, `${month}-01`, `${nextMonth(month)}-01`];
    const days = this.db.prepare(`SELECT date(c.committed_at, '+3 hours') AS day, COUNT(*) AS commits FROM commits c JOIN authors a ON a.id = c.author_id WHERE ${where} GROUP BY day ORDER BY day`).all(...args) as { day: string; commits: number }[];
    const repositories = this.db.prepare(`SELECT c.repository, COUNT(*) AS commits FROM commits c JOIN authors a ON a.id = c.author_id WHERE ${where} GROUP BY c.repository ORDER BY commits DESC, c.repository`).all(...args) as { repository: string; commits: number }[];
    const recent = this.db.prepare(`SELECT c.*, a.name AS author_name, s.additions, s.deletions, s.changed_files FROM commits c JOIN authors a ON a.id = c.author_id LEFT JOIN commit_stats s ON s.repository = c.repository AND s.sha = c.sha WHERE ${where} ORDER BY c.committed_at DESC LIMIT 500`).all(...args) as CommitRow[];
    return { activeDays: days.length, repositoryCount: repositories.length, days, repositories, recent };
  }

  authorInsight(id: number, month = currentMonth()): AuthorInsight | undefined {
    const row = this.db.prepare("SELECT summary, evidence, generated_at, commit_count FROM monthly_author_insights WHERE author_id = ? AND month = ?").get(id, month) as { summary: string; evidence: string; generated_at: string; commit_count: number } | undefined;
    return row ? { ...row, evidence: JSON.parse(row.evidence) as string[] } : undefined;
  }

  authorCommitBySha(id: number, sha: string): CommitRow | undefined {
    return this.db.prepare(`SELECT c.*, a.name AS author_name, s.additions, s.deletions, s.changed_files FROM commits c JOIN authors a ON a.id = c.author_id LEFT JOIN commit_stats s ON s.repository = c.repository AND s.sha = c.sha
      WHERE c.sha = ? AND (a.id = ? OR a.merged_into = ?) LIMIT 1`).get(sha, id, id) as CommitRow | undefined;
  }

  saveAuthorInsight(id: number, month: string, summary: string, evidence: string[], commitCount: number): void {
    this.db.prepare(`INSERT INTO monthly_author_insights(author_id, month, summary, evidence, generated_at, commit_count) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
      ON CONFLICT(author_id, month) DO UPDATE SET summary = excluded.summary, evidence = excluded.evidence, generated_at = excluded.generated_at, commit_count = excluded.commit_count`)
      .run(id, month, summary, JSON.stringify(evidence), commitCount);
  }

  repositories(): Repository[] {
    return this.db.prepare(`SELECT r.*, COUNT(c.sha) AS commit_count FROM repositories r
      LEFT JOIN commits c ON c.repository = r.full_name GROUP BY r.full_name ORDER BY r.full_name`).all() as Repository[];
  }

  repositoriesByAuthor(id: number): string[] {
    return this.db.prepare(`SELECT DISTINCT c.repository FROM commits c JOIN authors a ON a.id = c.author_id
      WHERE a.id = ? OR a.merged_into = ? ORDER BY c.repository`).all(id, id)
      .map((row) => (row as { repository: string }).repository);
  }

  branches(): { repository: string; branch: string; status: string; error: string | null }[] {
    return this.db.prepare("SELECT repository, branch, status, error FROM backfill ORDER BY repository, branch").all() as { repository: string; branch: string; status: string; error: string | null }[];
  }

  commits(filters: { author?: number; repository?: string; project?: number; from?: string; to?: string; page?: number }): CommitRow[] {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (filters.author) { conditions.push("(c.author_id = ? OR a.merged_into = ?)"); values.push(filters.author, filters.author); }
    if (filters.repository) { conditions.push("c.repository = ?"); values.push(filters.repository); }
    if (filters.project) { conditions.push("EXISTS (SELECT 1 FROM project_repositories pr WHERE pr.repository = c.repository AND pr.project_id = ?)"); values.push(filters.project); }
    if (filters.from) { conditions.push("datetime(c.committed_at, '+3 hours') >= datetime(?)"); values.push(`${filters.from}T00:00:00Z`); }
    if (filters.to) { conditions.push("datetime(c.committed_at, '+3 hours') < datetime(?, '+1 day')"); values.push(`${filters.to}T00:00:00Z`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT c.*, a.name AS author_name, s.additions, s.deletions, s.changed_files FROM commits c JOIN authors a ON a.id = c.author_id LEFT JOIN commit_stats s ON s.repository = c.repository AND s.sha = c.sha ${where}
      ORDER BY c.committed_at DESC LIMIT 50 OFFSET ?`).all(...values, Math.max(0, (filters.page ?? 1) - 1) * 50) as CommitRow[];
  }

  trend(month: string): { day: string; commits: number }[] {
    return this.db.prepare(`SELECT date(c.committed_at, '+3 hours') AS day, COUNT(*) AS commits FROM commits c
      JOIN authors a ON a.id = c.author_id LEFT JOIN authors root ON root.id = a.merged_into
      WHERE date(c.committed_at, '+3 hours') >= ? AND date(c.committed_at, '+3 hours') < ? AND COALESCE(root.hidden, a.hidden) = 0
      GROUP BY day ORDER BY day`).all(`${month}-01`, `${nextMonth(month)}-01`) as { day: string; commits: number }[];
  }

  weekdays(): { weekday: number; commits: number }[] {
    return this.db.prepare("SELECT CAST(strftime('%w', c.committed_at, '+3 hours') AS INTEGER) AS weekday, COUNT(*) AS commits FROM commits c JOIN authors a ON a.id = c.author_id LEFT JOIN authors root ON root.id = a.merged_into WHERE COALESCE(root.hidden, a.hidden) = 0 GROUP BY weekday ORDER BY weekday").all() as { weekday: number; commits: number }[];
  }

  setHidden(id: number, hidden: boolean): void {
    this.db.prepare("UPDATE authors SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, id);
  }

  mergeAuthor(source: number, target: number): void {
    if (source === target) throw new Error("Choose two different authors");
    this.db.transaction(() => {
      const targetRow = this.db.prepare("SELECT id FROM authors WHERE id = ? AND merged_into IS NULL").get(target);
      const sourceRow = this.db.prepare("SELECT id FROM authors WHERE id = ? AND merged_into IS NULL").get(source);
      if (!targetRow || !sourceRow) throw new Error("Choose two existing unmerged authors");
      this.db.prepare("UPDATE authors SET merged_into = ? WHERE merged_into = ?").run(target, source);
      this.db.prepare("UPDATE authors SET merged_into = ?, hidden = 1 WHERE id = ?").run(target, source);
    })();
  }

  unmergeAuthor(id: number): void {
    this.db.prepare("UPDATE authors SET merged_into = NULL, hidden = 0 WHERE id = ? AND merged_into IS NOT NULL").run(id);
  }
}
