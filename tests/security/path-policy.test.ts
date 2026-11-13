import { afterEach, describe, expect, it, vi } from "vitest";
import { writeNoteInput } from "../../src/schemas";
import { GitHubStorage } from "../../src/storage/github";
import type { VaultStorage } from "../../src/storage/types";
import { isPathVisible, normalizePath, VaultClient } from "../../src/vault";

const cfg = { allowedPrefixes: [], deniedPrefixes: [".git/", ".obsidian/", ".claude/"] };

describe("deny-prefix policy", () => {
	it.each([
		"./.claude/commands/evil.md",
		".claude//evil.md",
		"a/./b.md",
		".clau​de/evil.md",
		"a‮/b.md",
	])("normalizePath rejects %s", (p) => {
		expect(normalizePath(p)).toBeNull();
	});

	it.each([
		"./.claude/commands/evil.md",
		".Claude/commands/evil.md",
		".CLAUDE/agents/evil.md",
		"./.obsidian/app.json",
		".OBSIDIAN/x.md",
	])("hides %s", (p) => {
		expect(isPathVisible(p, cfg)).toBe(false);
	});
});

describe("write policy", () => {
	const writes: string[] = [];
	const storage: VaultStorage = {
		listFiles: async () => ({ files: [], truncated: false }),
		readFile: async () => "x",
		writeFile: async (p) => {
			writes.push(p);
			return { created: true };
		},
		deleteFile: async () => true,
		searchContent: async () => [],
	};
	const client = new VaultClient(storage, cfg);

	it.each([
		"CLAUDE.md",
		"projects/AGENTS.md",
		"notes/Gemini.md",
		".github/copilot-instructions.md",
		".trash/deleted-note.md",
	])("refuses to write %s", async (p) => {
		await expect(client.writeNote(p, "x")).rejects.toThrow(/read-only/);
		expect(writes).not.toContain(p);
	});

	it("still writes a normal note and lists a dir with a trailing slash", async () => {
		await expect(client.writeNote("projects/idea.md", "x")).resolves.toEqual({
			path: "projects/idea.md",
			created: true,
		});
		await expect(client.listNotes("projects/")).resolves.toBeTruthy();
	});

	it("caps note content at 512 KB", () => {
		expect(writeNoteInput.safeParse({ path: "a.md", content: "x".repeat(512 * 1024) }).success).toBe(true);
		expect(writeNoteInput.safeParse({ path: "a.md", content: "x".repeat(512 * 1024 + 1) }).success).toBe(false);
	});
});

describe("what the GitHub storage sends", () => {
	const calls: { method: string; url: string }[] = [];
	afterEach(() => {
		vi.unstubAllGlobals();
		calls.length = 0;
	});

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	function stubFetch(searchItems: unknown[] = []) {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			calls.push({ method, url });
			if (method === "GET" && url.includes("/contents/")) return json({ message: "Not Found" }, 404);
			if (url.includes("/search/code")) {
				return json({ total_count: searchItems.length, incomplete_results: false, items: searchItems });
			}
			if (url.includes("/git/trees/")) return json({ sha: "x", tree: [], truncated: false });
			return json({ content: { sha: "y" }, commit: { sha: "z" } }, 201);
		});
	}

	const client = () =>
		new VaultClient(new GitHubStorage({ owner: "o", repo: "r", branch: "main", token: "github_pat_dummy" }), cfg);

	it.each(["./.claude/commands/evil.md", ".Claude/commands/evil.md"])(
		"never sends a write for %s",
		async (p) => {
			stubFetch();
			await expect(client().writeNote(p, "pwn")).rejects.toThrow();
			expect(calls).toEqual([]);
		},
	);

	it("refuses to read a non-markdown file without calling GitHub", async () => {
		stubFetch();
		await expect(client().readNote(".github/workflows/deploy.yml")).rejects.toThrow(/Not a note/);
		expect(calls).toEqual([]);
	});

	it("drops search hits from other repos that a query qualifier pulls in", async () => {
		stubFetch([
			{ path: "notes/mine.md", repository: { full_name: "o/r" }, text_matches: [] },
			{ path: "secret.md", repository: { full_name: "someone/other-private-repo" }, text_matches: [] },
		]);
		const hits = await client().searchNotes("x repo:someone/other-private-repo", 5);
		expect(hits.map((h) => h.path)).toEqual(["notes/mine.md"]);
	});
});
