import type { CommitStore } from "./commit-store.js";

type GitHubRepository = { full_name: string };
type GitHubBranch = { name: string; commit: { sha: string } };
type GitHubCommit = {
  sha: string;
  html_url: string;
  author: { login: string } | null;
  commit: {
    message: string;
    author: { name: string; email: string; date: string } | null;
    committer: { date: string } | null;
  };
};

let running = false;
let scheduled = false;
let rerunRequested = false;

export function startGitHubHistory(store: CommitStore, token: string | undefined, organization: string): void {
  if (!token) {
    console.warn("GitHub history loading disabled: GITHUB_API_TOKEN is missing");
    return;
  }
  if (running) { rerunRequested = true; return; }
  running = true;
  void runHistory(store, token, organization)
    .catch((error: unknown) => console.error("GitHub history failed", error))
    .finally(() => {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        startGitHubHistory(store, token, organization);
      }
    });
  if (!scheduled) {
    scheduled = true;
    setInterval(() => startGitHubHistory(store, token, organization), 6 * 60 * 60 * 1000);
  }
}

export async function runHistory(store: CommitStore, token: string, organization: string): Promise<void> {
  const existing = new Set(store.repositories().map((repo) => repo.full_name));
  try {
    for await (const repository of paginate<GitHubRepository>(`/orgs/${encodeURIComponent(organization)}/repos?type=all`, token)) {
      store.addRepository(repository.full_name);
      existing.add(repository.full_name);
    }
  } catch (error) {
    console.error("GitHub repository discovery failed", error);
  }

  for (const repository of existing) {
    try {
      const [owner, repo] = repository.split("/");
      let branchCount = 0;
      for await (const branch of paginate<GitHubBranch>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`, token)) {
        store.addBranch(repository, branch.name, branch.commit.sha);
        branchCount += 1;
      }
      if (branchCount === 0) store.markEmptyRepository(repository);
    } catch (error) {
      store.setRepositoryError(repository, String(error));
      continue;
    }
  }

  for (const branch of store.pendingBranches()) {
    const [owner, repo] = branch.repository.split("/");
    let page = branch.page;
    try {
      while (true) {
        const params = new URLSearchParams({ sha: branch.head_sha, per_page: "100", page: String(page) });
        const commits = await githubGet<GitHubCommit[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${params}`, token);
        let reachedPreviousHead = false;
        for (const commit of commits) {
          if (branch.incremental && commit.sha === branch.previous_head_sha) {
            reachedPreviousHead = true;
            break;
          }
          const author = commit.commit.author;
          store.upsertCommit({
            repository: branch.repository,
            sha: commit.sha,
            message: commit.commit.message,
            committedAt: commit.commit.committer?.date ?? author?.date ?? new Date().toISOString(),
            authorName: author?.name ?? commit.author?.login ?? "Unknown",
            authorEmail: author?.email,
            authorLogin: commit.author?.login,
            url: commit.html_url,
          });
        }
        page += 1;
        store.setBranch(branch.repository, branch.branch, page, reachedPreviousHead || commits.length < 100 ? "complete" : "loading");
        if (reachedPreviousHead || commits.length < 100) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      store.setBranch(branch.repository, branch.branch, page, "error", String(error));
      console.error("GitHub branch history failed", { repository: branch.repository, branch: branch.branch, page, error });
    }
  }
}

async function* paginate<T>(path: string, token: string): AsyncGenerator<T> {
  let page = 1;
  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const rows = await githubGet<T[]>(`${path}${separator}per_page=100&page=${page}`, token);
    yield* rows;
    if (rows.length < 100) return;
    page += 1;
  }
}

async function githubGet<T>(path: string, token: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "manager-bot" },
    });
    if (response.ok) return await response.json() as T;
    if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < 3) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const wait = response.status === 403 && Number.isFinite(reset)
        ? Math.max(1000, Math.min(60_000, reset * 1000 - Date.now()))
        : 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    throw new Error(`GitHub API HTTP ${response.status} at ${path}`);
  }
  throw new Error(`GitHub API retries exhausted at ${path}`);
}
