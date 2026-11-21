import { beforeAll, describe, expect, it, mock } from "bun:test";

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((item) => matches(row, item));
    if (condition && typeof condition === "object" && !(condition instanceof Date) && "gte" in condition) {
      return row[key] >= condition.gte;
    }
    if (condition === null) return row[key] === null || row[key] === undefined;
    return row[key] === condition;
  });
}

function fakeTable() {
  const rows: Row[] = [];
  return {
    rows,
    async create({ data }: { data: Row }) {
      const row = { id: crypto.randomUUID(), createdAt: new Date(), consumedAt: null, revokedAt: null, ...data };
      rows.push(row);
      return row;
    },
    async findUnique({ where }: { where: Row }) {
      return rows.find((row) => matches(row, where)) ?? null;
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    },
  };
}

const user = { id: "user-1", email: "a@example.com", bearerToken: "web-session-token" };
const fakeDb = {
  oAuthClient: fakeTable(),
  oAuthAuthorizationCode: fakeTable(),
  oAuthToken: fakeTable(),
};

const dbModule = {
  db: fakeDb,
  users: {
    findById: async (id: string) => (id === user.id ? user : null),
    findByBearerToken: async (token: string) => (token === user.bearerToken ? user : null),
  },
  initDatabase: async () => {},
  generateId: () => crypto.randomUUID(),
  clients: {},
  urlRules: {},
  reports: {},
  nonAttributedReports: {},
  referrerRaws: {},
  nonAttributedRaws: {},
  logs: {},
  nonAttributedLogs: {},
};
mock.module(new URL("../../../../packages/db/index.ts", import.meta.url).pathname, () => dbModule);
mock.module(new URL("../../../../packages/db/index.js", import.meta.url).pathname, () => dbModule);

process.env.API_PUBLIC_URL = "https://api.example.com";
process.env.WEB_APP_URL = "https://app.example.com";

let oauthController: typeof import("../oauth.controller.ts").oauthController;
let mcpController: typeof import("../mcp.controller.ts").mcpController;
let computeS256Challenge: (verifier: string) => string;

beforeAll(async () => {
  ({ oauthController } = await import("../oauth.controller.ts"));
  ({ mcpController } = await import("../mcp.controller.ts"));
  ({ computeS256Challenge } = await import("../../services/mcp-oauth.service.ts"));
});

const API = "https://api.example.com";
const redirectUri = "http://127.0.0.1:33418/callback";
const verifier = "v".repeat(64);

function form(body: Record<string, string>) {
  return new Request(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

function mcpRequest(token?: string) {
  return new Request(`${API}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("MCP OAuth flow", () => {
  let clientId = "";
  let code = "";
  let tokens: Record<string, any> = {};

  it("challenges unauthenticated MCP requests with resource metadata", async () => {
    const response = await mcpController.remote(mcpRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${API}/.well-known/oauth-protected-resource/api/mcp"`,
    );

    const legacy = await mcpController.remote(mcpRequest(user.bearerToken));
    expect(legacy.status).toBe(401);
    expect(legacy.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("publishes discovery metadata", async () => {
    const resource = await oauthController.protectedResourceMetadata(new Request(`${API}/.well-known/oauth-protected-resource`)).json();
    expect(resource).toMatchObject({ resource: `${API}/api/mcp`, authorization_servers: [API] });
    const server = await oauthController.authorizationServerMetadata(new Request(`${API}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({ issuer: API, token_endpoint: `${API}/oauth/token`, code_challenge_methods_supported: ["S256"] });
  });

  it("registers a public client and rejects unsafe redirect URIs", async () => {
    const bad = await oauthController.register(
      new Request(`${API}/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.com/cb"] }) }),
    );
    expect(bad.status).toBe(400);

    const response = await oauthController.register(
      new Request(`${API}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ client_name: "Test Client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, any>;
    expect(body.client_secret).toBeUndefined();
    clientId = body.client_id;
  });

  it("hands a valid authorization request off to the web consent page", async () => {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: computeS256Challenge(verifier),
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${API}/api/mcp`,
    });
    const response = await oauthController.authorize(new Request(`${API}/oauth/authorize?${query}`));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://app.example.com/oauth/authorize?${query}`);

    const unregistered = new URLSearchParams(query);
    unregistered.set("redirect_uri", "http://127.0.0.1:1/other");
    const rejected = await oauthController.authorize(new Request(`${API}/oauth/authorize?${unregistered}`));
    expect(rejected.status).toBe(400);
  });

  it("issues a code when the signed-in user approves", async () => {
    const params = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: computeS256Challenge(verifier),
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${API}/api/mcp`,
    };
    const unauthorized = await oauthController.authorizeDecision(
      new Request(`${API}/api/oauth/authorize/decision`, { method: "POST", body: JSON.stringify({ ...params, approve: true }) }),
    );
    expect(unauthorized.status).toBe(401);

    const response = await oauthController.authorizeDecision(
      new Request(`${API}/api/oauth/authorize/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.bearerToken}` },
        body: JSON.stringify({ ...params, approve: true }),
      }),
    );
    const { redirectUrl } = (await response.json()) as { redirectUrl: string };
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe("xyz");
    code = url.searchParams.get("code") || "";
    expect(code).not.toBe("");
  });

  it("rejects a wrong PKCE verifier, then exchanges the code once", async () => {
    // A failed verifier still consumes the code, so use a fresh code for the failure case.
    const bad = await oauthController.token(
      form({ grant_type: "authorization_code", code: "nope", redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
    );
    expect(bad.status).toBe(400);

    const response = await oauthController.token(
      form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
    );
    expect(response.status).toBe(200);
    tokens = (await response.json()) as Record<string, any>;
    expect(tokens.token_type).toBe("Bearer");

    const replay = await oauthController.token(
      form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
    );
    expect(replay.status).toBe(400);
    // Replay revokes tokens issued from the code.
    expect((await mcpController.remote(mcpRequest(tokens.access_token))).status).toBe(401);
  });

  it("authorizes MCP calls with a fresh grant and rotates refresh tokens", async () => {
    const decision = await oauthController.authorizeDecision(
      new Request(`${API}/api/oauth/authorize/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.bearerToken}` },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          code_challenge: computeS256Challenge(verifier),
          code_challenge_method: "S256",
          approve: true,
        }),
      }),
    );
    const freshCode = new URL(((await decision.json()) as { redirectUrl: string }).redirectUrl).searchParams.get("code") || "";
    const issued = (await (
      await oauthController.token(
        form({ grant_type: "authorization_code", code: freshCode, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
      )
    ).json()) as Record<string, any>;

    const ok = await mcpController.remote(mcpRequest(issued.access_token));
    expect(ok.status).toBe(200);
    const listed = (await ok.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((tool) => tool.name)).toContain("delivery_dashboard");

    const refreshed = await oauthController.token(form({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: clientId }));
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Record<string, any>;
    expect(next.access_token).not.toBe(issued.access_token);
    expect((await mcpController.remote(mcpRequest(issued.access_token))).status).toBe(401);
    expect((await mcpController.remote(mcpRequest(next.access_token))).status).toBe(200);

    const reused = await oauthController.token(form({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: clientId }));
    expect(reused.status).toBe(400);

    await oauthController.revoke(
      new Request(`${API}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: next.access_token, client_id: clientId }).toString(),
      }),
    );
    expect((await mcpController.remote(mcpRequest(next.access_token))).status).toBe(401);
  });

  it("redirects access_denied when the user denies", async () => {
    const response = await oauthController.authorizeDecision(
      new Request(`${API}/api/oauth/authorize/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.bearerToken}` },
        body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, state: "s1", approve: false }),
      }),
    );
    const url = new URL(((await response.json()) as { redirectUrl: string }).redirectUrl);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("s1");
  });
});
