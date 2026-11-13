import { beforeEach, describe, expect, it, vi } from "vitest";

const octo = vi.hoisted(() => {
	const getAuthenticated = vi.fn();
	return {
		getAuthenticated,
		Octokit: vi.fn(function Octokit() {
			return { rest: { users: { getAuthenticated } } };
		}),
	};
});
vi.mock("octokit", () => ({ Octokit: octo.Octokit }));

import { createAuthHandler } from "../../src/auth/handler";
import { githubProvider } from "../../src/auth/providers/github";
import { bindStateToSession, createOAuthState } from "../../src/auth/session";

const SECRET = "test-cookie-signing-secret-0000000000";

const makeKV = () => {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (k: string) => store.get(k) ?? null),
		put: vi.fn(async (k: string, v: string) => {
			store.set(k, v);
		}),
		delete: vi.fn(async (k: string) => {
			store.delete(k);
		}),
	};
};

let kv: ReturnType<typeof makeKV>;
let completeAuthorization: ReturnType<typeof vi.fn>;

// The real claude.ai callback, so the default redirect allowlist applies.
const reqInfo = {
	clientId: "c1",
	scope: ["read"],
	redirectUri: "https://claude.ai/api/mcp/auth_callback",
	responseType: "code",
	state: "abc",
};

const GitHubHandler = createAuthHandler(githubProvider);

const callback = async () => {
	const { stateToken } = await createOAuthState(reqInfo as never, kv as never);
	const { setCookie } = await bindStateToSession(stateToken);
	const consented = setCookie.split(";")[0].split("=").slice(1).join("=");
	const env = {
		OAUTH_PROVIDER: { completeAuthorization },
		OAUTH_KV: kv,
		GITHUB_CLIENT_ID: "cid",
		GITHUB_CLIENT_SECRET: "secret",
		COOKIE_ENCRYPTION_KEY: SECRET,
		VAULT_ALLOWED_GITHUB_LOGINS: "owner",
	};
	return GitHubHandler.request(
		`https://mcp.example/callback?state=${stateToken}&code=x`,
		{ headers: { Cookie: `__Host-CONSENTED_STATE=${consented}` } },
		env as never,
	);
};

beforeEach(() => {
	vi.clearAllMocks();
	kv = makeKV();
	completeAuthorization = vi.fn(async () => ({ redirectTo: `${reqInfo.redirectUri}?code=granted` }));
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "gho_upstream" })));
	return () => vi.unstubAllGlobals();
});

describe("GitHub callback", () => {
	it("refuses a login that is not on the allowlist before any grant is minted", async () => {
		octo.getAuthenticated.mockResolvedValue({ data: { login: "mallory", name: "M", email: "" } });
		const res = await callback();
		expect(res.status).toBe(403);
		expect(completeAuthorization).not.toHaveBeenCalled();
	});

	it("grants an allowlisted login without storing the upstream GitHub token", async () => {
		octo.getAuthenticated.mockResolvedValue({ data: { login: "owner", name: "O", email: "" } });
		const res = await callback();
		expect(res.status).toBe(302);
		expect(completeAuthorization).toHaveBeenCalledTimes(1);
		const arg = completeAuthorization.mock.calls[0][0];
		expect(arg.userId).toBe("owner");
		expect(arg.props).not.toHaveProperty("accessToken");
		expect(JSON.stringify(arg)).not.toContain("gho_upstream");
	});
});
