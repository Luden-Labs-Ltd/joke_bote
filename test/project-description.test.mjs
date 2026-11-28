import assert from "node:assert/strict";
import { test } from "node:test";
import { collectProjectSources, generateProjectDraft, rankProjectDocuments } from "../dist/project-description.js";

test("project documents prefer overview and specifications over irrelevant files", () => {
  const files = [
    { path: "src/util.ts", type: "blob", size: 200 },
    { path: "docs/specifications/product-vision.md", type: "blob", size: 200 },
    { path: "README.md", type: "blob", size: 200 },
    { path: "node_modules/foo/README.md", type: "blob", size: 200 },
  ];
  assert.deepEqual(rankProjectDocuments(files), ["README.md", "docs/specifications/product-vision.md"]);
});

test("AI draft is grounded in tracker, README and specification with inspectable source links", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url.includes("generativelanguage.googleapis.com")) {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      assert.match(prompt, /Платформа поддержки людей/);
      assert.match(prompt, /Product specification/);
      assert.match(prompt, /README product purpose/);
      assert.ok(prompt.indexOf("Платформа поддержки людей") < prompt.indexOf("Product specification"));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Помогает людям проходить восстановление с ментором." }] } }] }), { status: 200 });
    }
    seen.push(url);
    if (url.endsWith("/repos/org/app")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [
      { path: "README.md", type: "blob", size: 1000 },
      { path: "docs/product-overview.md", type: "blob", size: 1000 },
    ] }), { status: 200 });
    const text = url.endsWith("README.md") ? "README product purpose ".repeat(8) : "Product specification ".repeat(8);
    return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(text).toString("base64") }), { status: 200 });
  };
  try {
    const project = { name: "Retorno", repositories: ["org/app"], tracker_context: "Платформа поддержки людей на пути восстановления от зависимостей.", tracker_context_url: "https://tracker.luden-labs.com/project/browse/RETORNO-2/", tracker_url: "" };
    const sources = await collectProjectSources(project, "token");
    assert.equal(sources.length, 3);
    const draft = await generateProjectDraft(project, "token", "key", "gemini-2.5-flash");
    assert.match(draft.text, /ментором/);
    assert.deepEqual(draft.sources, sources.map((source) => source.label));
    assert.ok(seen.some((url) => url.includes("product-overview.md")));
  } finally {
    globalThis.fetch = original;
  }
});
