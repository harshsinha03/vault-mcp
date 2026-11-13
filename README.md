# vault-mcp

[![Release](https://img.shields.io/github/v/release/wakita181009/vault-mcp)](https://github.com/wakita181009/vault-mcp/releases/latest)
[![codecov](https://codecov.io/gh/wakita181009/vault-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/wakita181009/vault-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Authenticated **remote MCP server** on Cloudflare Workers that exposes a private, GitHub-hosted
Obsidian vault to both **claude.ai** (Web / Desktop / iPhone) and **Claude Code** — one free
deployment serving every Claude surface. It reads notes and creates/overwrites them; deleting
is off by default and can be turned on with `VAULT_DISABLED_TOOLS`. It never renames or moves.
Every mutation is a git commit, so writes and deletes stay revertable.

It works against the vault through the GitHub API, so the source repo can stay private and there is
no always-on machine to maintain. Deploy your own instance with C3 (one command) or clone it
manually — both are covered below. Your vault target is set via secrets, so the committed config
ships generic.

## What it does

- **Auth:** OAuth via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
  delegating sign-in to **GitHub** (default), **Google** (`AUTH_PROVIDER=google`), or any **OpenID
  Connect** IdP (`AUTH_PROVIDER=oidc`). Only identities on the provider's allowlist
  (`VAULT_ALLOWED_GITHUB_LOGINS` / `VAULT_ALLOWED_GOOGLE_EMAILS` / `VAULT_ALLOWED_OIDC_EMAILS`) get any tools at all.
- **Accesses the vault** through the GitHub API using a **separate fine-grained PAT**
  (`VAULT_GITHUB_TOKEN`) scoped to Contents Read + Write on the one vault repo.
- **Transport:** Streamable HTTP at `/mcp`.

### Tools

| Tool | Description |
| --- | --- |
| `list_notes` | List note (`.md`) paths, optionally scoped to a subdirectory. |
| `read_note` | Read the raw markdown of one note by repo-relative path. |
| `write_note` | Create a new note or overwrite an existing one (markdown paths only, at most 512 KB of content). |
| `delete_note` | Delete an existing note by path (markdown paths only; recorded as a revertable git commit). **Off by default.** |
| `search_notes` | Content search (GitHub code search, indexed) + filename search, merged. Only hits from the vault repo are returned. |

`VAULT_DISABLED_TOOLS` lists tools that are never registered (comma-separated; default
`delete_note`). Set it to an empty string to enable `delete_note`, or to
`write_note,delete_note` for a read-only deploy.

## Two credentials, two jobs

| Purpose | Credential | Scope |
| --- | --- | --- |
| **Who may log in** | GitHub **OAuth App** (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`), Google **OAuth client** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), or an **OIDC client** (`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`) | `read:user` / `openid email profile` only |
| **What the server accesses** | **fine-grained PAT** (`VAULT_GITHUB_TOKEN`) | Contents: Read & Write, limited to your vault repo |

Keeping them separate means logging in never grants repo write via the OAuth app, and the
vault PAT is scoped to exactly one repo. **Keep the PAT scoped to that single repo** — this
server needs read and write on the vault, but nothing beyond it.

### Login provider

`AUTH_PROVIDER` selects who verifies the user; it defaults to `github`. Each provider has
its own OAuth app secrets and its own allowlist, because the identity it yields differs:

| `AUTH_PROVIDER` | OAuth app secrets | Allowlist (comma-separated) | Identity matched |
| --- | --- | --- | --- |
| `github` (default) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `VAULT_ALLOWED_GITHUB_LOGINS` | GitHub login |
| `google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `VAULT_ALLOWED_GOOGLE_EMAILS` | verified Google email (case-insensitive) |
| `oidc` | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | `VAULT_ALLOWED_OIDC_EMAILS` | verified email from the IdP's `userinfo` (case-insensitive) |

Only the selected provider's keys are required. Accounts whose email is not verified are
rejected before the allowlist is consulted, and an identity that is not on the allowlist is
refused at login — no grant is issued for it. The upstream provider's access token is used
only to look up the identity and is not stored in the grant.

### Redirect URIs

Anyone can register an OAuth client with the server, so an authorization code is only ever
sent to a redirect URI on `VAULT_ALLOWED_REDIRECT_URIS` (comma-separated, exact match). The
default allows claude.ai only:

```
https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback
```

Other clients need their callback added. Claude Code uses a loopback callback
(`http://localhost:<port>/callback`), so register it with a fixed port
(`claude mcp add --callback-port <port> …`) and include that URI; for local testing with the
MCP inspector, add the inspector's callback URL. Overriding the setting replaces the default,
so keep the claude.ai entries in the list if you still use claude.ai.

The `oidc` provider works with any OpenID Connect IdP — Microsoft Entra ID, Okta, Auth0,
Keycloak, Slack, … — and resolves its endpoints from
`<OIDC_ISSUER_URL>/.well-known/openid-configuration`. Two optional secrets tune it:

- `OIDC_DISPLAY_NAME` — the name shown on the approval dialog (default `OpenID`).
- `OIDC_ALLOW_UNVERIFIED_EMAIL=true` — accept a `userinfo` response that omits
  `email_verified`. Some IdPs (Entra ID among them) never send the claim, so without this the
  login is rejected. An explicit `email_verified: false` is rejected regardless. Only enable
  this on an IdP you control where every account's email is provisioned by an admin; on a
  multi-tenant or self-service IdP an attacker could register the allowlisted address.

## Access scope

Path visibility is controlled by two settings that default in `src/config.ts`; override
either per deploy with a secret of the same name (`wrangler secret put`):

- `VAULT_ALLOWED_PREFIXES` — if non-empty, only paths under these prefixes are exposed (default: empty = whole repo).
- `VAULT_DENIED_PREFIXES` — always hidden (default: `.git/,.obsidian/,.claude/`).

Prefixes match case-insensitively, so `.Claude/x.md` is hidden just like `.claude/x.md` (the
vault is often checked out on a case-insensitive filesystem, where both are the same folder).

`read_note`, `write_note`, and `delete_note` all reject absolute paths, `..` traversal, empty
or `.` segments (`./.claude/x.md`, `a//b.md`), and control, zero-width, or bidi characters, and
all three only accept markdown paths (`.md` / `.markdown`) — the deny/allow policy applies
equally to reads, writes, and deletes, so a mutation can never escape into `.git/`,
`.obsidian/`, or agent dirs. To hide (and block writes/deletes to) additional folders, override
`VAULT_DENIED_PREFIXES` with your extra prefixes.

On top of that, `write_note` and `delete_note` never touch:

- any path with a segment starting with `.` (`.github/`, `.trash/`, …), even if it is readable;
- agent instruction files — `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, in any
  folder and any letter case — which an AI coding agent opened in the vault checkout would load
  as instructions.

These stay readable unless they are also denied.

## Quick start (C3)

Scaffold your own copy with Cloudflare's [C3](https://developers.cloudflare.com/pages/get-started/c3/):

```bash
npm create cloudflare@latest vault-mcp -- --template wakita181009/vault-mcp
cd vault-mcp
```

That clones the project and installs dependencies — but not the one-time setup:
you still create the KV namespace, the OAuth app (GitHub or Google), and the fine-grained PAT
(Contents: Read and write), and set the secrets. Continue with [Setup](#setup) from **step 2** (step 1 is done for
you). Cloning the repo directly works too; then start from step 0.

## Setup

### 0. Prereqs

```bash
pnpm install
pnpm exec wrangler login    # Cloudflare auth
```

### 1. Point it at your vault

Your vault target (`VAULT_OWNER` / `VAULT_REPO`) and login allowlist
(`VAULT_ALLOWED_GITHUB_LOGINS` or `VAULT_ALLOWED_GOOGLE_EMAILS`) are **secrets**, set in step 5 — you don't edit
`wrangler.jsonc` to point it at your repo. The committed `wrangler.jsonc` ships
generic; its only per-deploy value is the KV namespace id (step 2). Everything
else defaults in `src/config.ts` and is optional — override any of these per deploy
with `wrangler secret put <NAME>`:

- `VAULT_BRANCH` — branch of the vault repo to read (default `main`).
- `VAULT_ALLOWED_PREFIXES` / `VAULT_DENIED_PREFIXES` — see [Access scope](#access-scope) above.
- `VAULT_DISABLED_TOOLS` — tools left out (default `delete_note`); see [Tools](#tools) above.
- `VAULT_ALLOWED_REDIRECT_URIS` — where authorization codes may be sent (default: the claude.ai
  callbacks); see [Redirect URIs](#redirect-uris) above.

### 2. Create the KV namespace (stores OAuth grants)

```bash
pnpm exec wrangler kv namespace create OAUTH_KV
```

Put the returned `id` into `wrangler.jsonc` under `kv_namespaces[0].id`.

### 3. Create the PAT for accessing the vault

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:

- Resource owner: your account, Repository access: **Only** your vault repo
- Permissions: **Contents → Read and write**

Save the token for `VAULT_GITHUB_TOKEN` below.

### 4. Create the OAuth app for login

Pick one provider (see [Login provider](#login-provider)). Either way you need **two** apps
(or one with a second callback): local + production. The callback URL is `<origin>/callback`:

- **Local:** `http://localhost:8788/callback`
- **Prod:** `https://vault-mcp.<subdomain>.workers.dev/callback`

**GitHub (default):** GitHub → Settings → Developer settings → **OAuth Apps** → New. Note the
Client ID and generate a Client Secret (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`).

**Google:** Google Cloud Console → APIs & Services → **Credentials** → Create OAuth client ID
(type: Web application) with the callback above as an authorized redirect URI; configure the
OAuth consent screen if prompted. Note the Client ID and Client Secret
(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) and set `AUTH_PROVIDER=google`.

**OIDC:** register a confidential web client with your IdP, add the callback above as a
redirect URI, and grant it the `openid`, `email`, and `profile` scopes. Note the issuer URL
(e.g. `https://login.microsoftonline.com/<tenant-id>/v2.0` for Entra ID, or
`https://<org>.okta.com` for Okta), the Client ID, and the Client Secret
(`OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`) and set `AUTH_PROVIDER=oidc`.

### 5a. Run locally

```bash
cp .dev.vars.example .dev.vars    # LOCAL OAuth app, PAT, vault owner/repo, allowlist
openssl rand -hex 32              # value for COOKIE_ENCRYPTION_KEY
pnpm dev                          # http://localhost:8788/mcp
```

Test with the MCP inspector:

```bash
pnpm dlx @modelcontextprotocol/inspector@latest
# add the inspector's OAuth callback URL to VAULT_ALLOWED_REDIRECT_URIS in .dev.vars,
# then connect to http://localhost:8788/mcp and complete the login
```

### 5b. Deploy to production

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_ID            # PROD OAuth app (GitHub login)
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put VAULT_ALLOWED_GITHUB_LOGINS # comma-separated allowed GitHub logins
pnpm exec wrangler secret put COOKIE_ENCRYPTION_KEY       # openssl rand -hex 32
pnpm exec wrangler secret put VAULT_GITHUB_TOKEN          # fine-grained PAT, Contents R/W on the vault repo
pnpm exec wrangler secret put VAULT_OWNER                 # GitHub owner of the vault repo
pnpm exec wrangler secret put VAULT_REPO                  # vault repo name
pnpm run deploy
```

For Google login, replace the first three secrets with:

```bash
pnpm exec wrangler secret put AUTH_PROVIDER               # google
pnpm exec wrangler secret put GOOGLE_CLIENT_ID            # PROD OAuth client (Google login)
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put VAULT_ALLOWED_GOOGLE_EMAILS # comma-separated allowed Google emails
```

For a generic OIDC IdP, replace them with:

```bash
pnpm exec wrangler secret put AUTH_PROVIDER               # oidc
pnpm exec wrangler secret put OIDC_ISSUER_URL             # e.g. https://login.microsoftonline.com/<tenant-id>/v2.0
pnpm exec wrangler secret put OIDC_CLIENT_ID              # PROD OIDC client
pnpm exec wrangler secret put OIDC_CLIENT_SECRET
pnpm exec wrangler secret put VAULT_ALLOWED_OIDC_EMAILS   # comma-separated allowed emails
pnpm exec wrangler secret put OIDC_DISPLAY_NAME           # optional, e.g. "Acme SSO"
pnpm exec wrangler secret put OIDC_ALLOW_UNVERIFIED_EMAIL # optional: "true" for IdPs that omit email_verified
```

Endpoint: `https://vault-mcp.<subdomain>.workers.dev/mcp`

### 6. Connect the clients

- **claude.ai (Web):** Settings → Connectors → add custom connector with the `/mcp` URL.
  Registration is Web-only; it then syncs to Desktop and the iPhone app.
- **Claude Code:** `claude mcp add --transport http --callback-port <port> vault https://vault-mcp.<subdomain>.workers.dev/mcp`
  (completes the OAuth flow in the browser), after adding `http://localhost:<port>/callback` to
  `VAULT_ALLOWED_REDIRECT_URIS` (see [Redirect URIs](#redirect-uris)). Works even on a Mac that
  has not cloned the vault.

## Development

```bash
pnpm typecheck     # verify generated Worker types, then run tsc --noEmit
pnpm lint          # biome lint ./src
pnpm test          # vitest run
pnpm cf-typegen    # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm dev           # local Worker at :8788 (vite dev + @cloudflare/vite-plugin)
pnpm build         # vite build → dist/vault_mcp (bundle + generated wrangler.json)
```

Secrets are typed in `src/env.d.ts` (they are not part of the `wrangler types` output).
After changing `wrangler.jsonc` bindings/vars, rerun `pnpm cf-typegen`.

### Build pipeline

The Worker is built with Vite via [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/).
`vite build` writes the bundle and a generated `wrangler.json` to `dist/vault_mcp/`,
plus a `.wrangler/deploy/config.json` redirect so a plain `wrangler deploy` (and
`wrangler deploy --dry-run`) picks up the built output. `pnpm deploy` chains both steps.

MCP tool input schemas live in `src/schemas.ts` (plain Zod, no other imports) and are
compiled at build time by [`zod-aot`](https://github.com/wakita181009/zod-aot)
(`autoDiscover` scoped to that file — it executes matched files during the build, so the
schema module must stay side-effect free). Inspect compilation coverage with:

```bash
pnpm exec zod-aot check src/schemas.ts --auto-discover
```

## Layout

```
src/
├── index.ts                   # VaultMCP (McpAgent) + Worker entry; registers the tools
├── oauth-provider.ts          # OAuthProvider built per request (canonical resource = origin + /mcp)
├── schemas.ts                 # MCP tool input schemas (compiled at build time by zod-aot)
├── tools.ts                   # MCP tool handlers (list/read/write/delete/search) + result & allowlist helpers
├── guard.ts                   # login-allowlist gate wrapping the MCP API handler (per AUTH_PROVIDER)
├── vault.ts                   # Backend-agnostic policy layer: list/read/write/delete/search + path guards
├── storage/
│   ├── types.ts               # VaultStorage interface every backend implements (+ VaultError)
│   └── github.ts              # GitHub API backend (Octokit)
├── config.ts                  # env schema + defaults; parseEnv validates at startup
├── env.d.ts                   # secret bindings type augmentation
└── auth/
    ├── handler.ts             # provider-agnostic OAuth login flow (Hono)
    ├── approval-dialog.ts     # OAuth approval dialog + HTML sanitization
    ├── session.ts             # OAuth state / CSRF / approved-clients cookie
    ├── upstream.ts            # upstream OAuth authorize URL + token exchange
    ├── props.ts               # identity captured at login, surfaced to the DO as this.props
    └── providers/             # upstream identity providers (selector in index.ts)
        ├── types.ts           # UpstreamProvider interface
        ├── github.ts
        ├── google.ts          # preset of the OIDC factory with pinned endpoints
        └── oidc/              # generic OIDC: factory + provider, discovery, fetch options
```

Tests live in `tests/` (Vitest), mirroring the `src/` layout.

To add another data source, implement `VaultStorage` from `src/storage/types.ts` and construct it
in `vaultClientFromEnv` (`src/vault.ts`). Backends only move bytes; path policy stays in `VaultClient`.

Derived from Cloudflare's `remote-mcp-github-oauth` template.
