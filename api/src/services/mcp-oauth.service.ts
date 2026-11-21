import { db, users } from "../../../packages/db/index.js";

export const MCP_OAUTH_SCOPE = "mcp";
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SUPPORTED_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type TokenEndpointAuthMethod = (typeof SUPPORTED_AUTH_METHODS)[number];

const oauthDb = db as any;

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
  }

  toResponse(headers?: Record<string, string>) {
    return Response.json(
      { error: this.error, error_description: this.description },
      { status: this.status, headers: { "Cache-Control": "no-store", ...headers } },
    );
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

/** Public base URL of this API (OAuth issuer). Prefer API_PUBLIC_URL; fall back to proxy headers / request URL. */
export function getApiBaseUrl(req: Request) {
  const configured = process.env.API_PUBLIC_URL?.trim();
  if (configured) return trimTrailingSlash(configured);

  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

export function getWebAppUrl() {
  return trimTrailingSlash(process.env.WEB_APP_URL?.trim() || "http://localhost:5173");
}

export function getMcpResourceUrl(req: Request) {
  return `${getApiBaseUrl(req)}/api/mcp`;
}

export function getProtectedResourceMetadataUrl(req: Request) {
  return `${getApiBaseUrl(req)}/.well-known/oauth-protected-resource/api/mcp`;
}

export function getProtectedResourceMetadata(req: Request) {
  return {
    resource: getMcpResourceUrl(req),
    authorization_servers: [getApiBaseUrl(req)],
    bearer_methods_supported: ["header"],
    scopes_supported: [MCP_OAUTH_SCOPE],
    resource_name: "AI Referrer MCP",
  };
}

export function getAuthorizationServerMetadata(req: Request) {
  const base = getApiBaseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [MCP_OAUTH_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [...SUPPORTED_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...SUPPORTED_AUTH_METHODS],
    code_challenge_methods_supported: ["S256"],
  };
}

function randomToken(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}${Buffer.from(bytes).toString("base64url")}`;
}

export function hashSecret(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function timingSafeEqualHex(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export function computeS256Challenge(verifier: string) {
  return new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
}

function normalizeResource(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return "";
  }
}

/** Validates an RFC 8707 resource indicator against this MCP server. Returns the canonical resource or null. */
export function validateResource(req: Request, resource: string | null | undefined) {
  if (!resource) return null;
  const expected = normalizeResource(getMcpResourceUrl(req));
  const provided = normalizeResource(resource);
  const base = normalizeResource(getApiBaseUrl(req));
  if (provided !== expected && provided !== base) {
    throw new OAuthError("invalid_target", "resource does not identify this MCP server");
  }
  return expected;
}

export function isAllowedRedirectUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  const protocol = url.protocol.toLowerCase();
  if (protocol === "https:") return true;
  if (protocol === "http:") {
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  }
  // Private-use URI schemes for native apps (RFC 8252), e.g. cursor://, vscode://
  return !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"].includes(protocol) && /^[a-z][a-z0-9+.-]*:$/.test(protocol);
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function registerClient(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthError("invalid_client_metadata", "Registration body must be a JSON object");
  }
  const metadata = body as Record<string, unknown>;
  const redirectUris = readStringArray(metadata.redirect_uris);
  if (redirectUris.length === 0) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris is required");
  }
  const invalidUri = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
  if (invalidUri) {
    throw new OAuthError("invalid_redirect_uri", `Unsupported redirect_uri: ${invalidUri}`);
  }

  const requestedAuthMethod = typeof metadata.token_endpoint_auth_method === "string" ? metadata.token_endpoint_auth_method : "none";
  if (!SUPPORTED_AUTH_METHODS.includes(requestedAuthMethod as TokenEndpointAuthMethod)) {
    throw new OAuthError("invalid_client_metadata", `Unsupported token_endpoint_auth_method: ${requestedAuthMethod}`);
  }
  const authMethod = requestedAuthMethod as TokenEndpointAuthMethod;

  const grantTypes = readStringArray(metadata.grant_types);
  const unsupportedGrant = grantTypes.find((grant) => !["authorization_code", "refresh_token"].includes(grant));
  if (unsupportedGrant) {
    throw new OAuthError("invalid_client_metadata", `Unsupported grant_type: ${unsupportedGrant}`);
  }
  const responseTypes = readStringArray(metadata.response_types);
  if (responseTypes.some((type) => type !== "code")) {
    throw new OAuthError("invalid_client_metadata", "Only response_type code is supported");
  }

  const clientName = typeof metadata.client_name === "string" ? metadata.client_name.trim().slice(0, 200) : "";
  const clientId = randomToken("mcpc_");
  const clientSecret = authMethod === "none" ? null : randomToken("mcps_");

  const created = await oauthDb.oAuthClient.create({
    data: {
      clientId,
      clientSecretHash: clientSecret ? hashSecret(clientSecret) : null,
      clientName: clientName || null,
      redirectUris,
      tokenEndpointAuthMethod: authMethod,
    },
  });

  return {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(new Date(created.createdAt).getTime() / 1000),
    client_name: clientName || undefined,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: MCP_OAUTH_SCOPE,
  };
}

export async function findClient(clientId: string) {
  if (!clientId) return null;
  return await oauthDb.oAuthClient.findUnique({ where: { clientId } });
}

export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
};

export function readAuthorizationRequest(params: URLSearchParams | Record<string, unknown>): AuthorizationRequest {
  const read = (key: string) => {
    const value = params instanceof URLSearchParams ? params.get(key) : params[key];
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    clientId: read("client_id"),
    redirectUri: read("redirect_uri"),
    responseType: read("response_type"),
    codeChallenge: read("code_challenge"),
    codeChallengeMethod: read("code_challenge_method"),
    state: read("state"),
    scope: read("scope"),
    resource: read("resource"),
  };
}

// Only one scope exists; unknown requested scopes are ignored rather than rejected so generic clients still work.
function normalizeScope(_scope: string) {
  return MCP_OAUTH_SCOPE;
}

/**
 * Validates client_id + redirect_uri. Errors here must NOT be redirected to the client (RFC 6749 §4.1.2.1).
 */
export async function validateClientRedirect(request: AuthorizationRequest) {
  const client = await findClient(request.clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id");
  const redirectUris = readStringArray(client.redirectUris);
  if (!request.redirectUri || !redirectUris.includes(request.redirectUri)) {
    throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
  }
  return client;
}

/** Validates the remaining parameters. Errors here may be redirected to the client's redirect_uri. */
export function validateAuthorizationParams(req: Request, request: AuthorizationRequest) {
  if (request.responseType !== "code") {
    throw new OAuthError("unsupported_response_type", "response_type must be code");
  }
  if (!request.codeChallenge) {
    throw new OAuthError("invalid_request", "code_challenge is required (PKCE)");
  }
  if (request.codeChallengeMethod !== "S256") {
    throw new OAuthError("invalid_request", "code_challenge_method must be S256");
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(request.codeChallenge)) {
    throw new OAuthError("invalid_request", "code_challenge is malformed");
  }
  return {
    scope: normalizeScope(request.scope),
    resource: validateResource(req, request.resource),
  };
}

export function buildRedirectUrl(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function createAuthorizationCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
}) {
  const code = randomToken("mcpa_");
  await oauthDb.oAuthAuthorizationCode.create({
    data: {
      codeHash: hashSecret(code),
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      scope: input.scope,
      resource: input.resource,
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
    },
  });
  return code;
}

export type ClientCredentials = { clientId: string; clientSecret: string };

export function readClientCredentials(req: Request, form: URLSearchParams): ClientCredentials {
  const header = req.headers.get("authorization")?.trim() || "";
  const [scheme, value] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() === "basic" && value) {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, separator)),
          clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
        };
      }
    } catch {
      throw new OAuthError("invalid_client", "Malformed Basic authorization header", 401);
    }
  }
  return {
    clientId: form.get("client_id")?.trim() || "",
    clientSecret: form.get("client_secret")?.trim() || "",
  };
}

export async function authenticateClient(credentials: ClientCredentials) {
  const client = await findClient(credentials.clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id", 401);
  if (client.tokenEndpointAuthMethod !== "none") {
    if (!credentials.clientSecret || !client.clientSecretHash || !timingSafeEqualHex(hashSecret(credentials.clientSecret), client.clientSecretHash)) {
      throw new OAuthError("invalid_client", "Client authentication failed", 401);
    }
  }
  return client;
}

async function issueTokens(input: { clientId: string; userId: string; scope: string; resource: string | null }) {
  const accessToken = randomToken("mcpat_");
  const refreshToken = randomToken("mcprt_");
  const now = Date.now();
  await oauthDb.oAuthToken.create({
    data: {
      accessTokenHash: hashSecret(accessToken),
      refreshTokenHash: hashSecret(refreshToken),
      clientId: input.clientId,
      userId: input.userId,
      scope: input.scope,
      resource: input.resource,
      accessTokenExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
      refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
    },
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: input.scope,
  };
}

export async function exchangeAuthorizationCode(req: Request, form: URLSearchParams, clientId: string) {
  const code = form.get("code")?.trim() || "";
  const redirectUri = form.get("redirect_uri")?.trim() || "";
  const codeVerifier = form.get("code_verifier")?.trim() || "";
  if (!code) throw new OAuthError("invalid_request", "code is required");
  if (!codeVerifier) throw new OAuthError("invalid_request", "code_verifier is required");

  const record = await oauthDb.oAuthAuthorizationCode.findUnique({ where: { codeHash: hashSecret(code) } });
  if (!record || record.clientId !== clientId) {
    throw new OAuthError("invalid_grant", "Authorization code is invalid");
  }

  // Single use: atomically mark consumed. If it was already used, revoke tokens issued from it (RFC 6749 §4.1.2).
  const consumed = await oauthDb.oAuthAuthorizationCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    await oauthDb.oAuthToken.updateMany({
      where: { clientId: record.clientId, userId: record.userId, createdAt: { gte: record.createdAt }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new OAuthError("invalid_grant", "Authorization code has already been used");
  }

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    throw new OAuthError("invalid_grant", "Authorization code has expired");
  }
  if (redirectUri !== record.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (computeS256Challenge(codeVerifier) !== record.codeChallenge) {
    throw new OAuthError("invalid_grant", "code_verifier does not match code_challenge");
  }
  const requestedResource = form.get("resource")?.trim();
  const resource = requestedResource ? validateResource(req, requestedResource) : record.resource;
  if (record.resource && resource !== record.resource) {
    throw new OAuthError("invalid_target", "resource does not match the authorization request");
  }

  return await issueTokens({ clientId: record.clientId, userId: record.userId, scope: record.scope, resource });
}

export async function exchangeRefreshToken(req: Request, form: URLSearchParams, clientId: string) {
  const refreshToken = form.get("refresh_token")?.trim() || "";
  if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");

  const record = await oauthDb.oAuthToken.findUnique({ where: { refreshTokenHash: hashSecret(refreshToken) } });
  if (!record || record.clientId !== clientId || record.revokedAt) {
    throw new OAuthError("invalid_grant", "Refresh token is invalid");
  }
  if (!record.refreshTokenExpiresAt || new Date(record.refreshTokenExpiresAt).getTime() < Date.now()) {
    throw new OAuthError("invalid_grant", "Refresh token has expired");
  }
  const requestedResource = form.get("resource")?.trim();
  if (requestedResource && record.resource && validateResource(req, requestedResource) !== record.resource) {
    throw new OAuthError("invalid_target", "resource does not match the original grant");
  }

  // Rotate: revoke the old pair before issuing a new one.
  const revoked = await oauthDb.oAuthToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count !== 1) throw new OAuthError("invalid_grant", "Refresh token is invalid");

  return await issueTokens({ clientId: record.clientId, userId: record.userId, scope: record.scope, resource: record.resource });
}

export async function revokeToken(token: string, clientId: string) {
  if (!token) return;
  const hash = hashSecret(token);
  await oauthDb.oAuthToken.updateMany({
    where: { clientId, revokedAt: null, OR: [{ accessTokenHash: hash }, { refreshTokenHash: hash }] },
    data: { revokedAt: new Date() },
  });
}

/** Resolves an OAuth access token presented to the MCP endpoint into a user. */
export async function authenticateMcpAccessToken(req: Request, token: string) {
  if (!token) return null;
  const record = await oauthDb.oAuthToken.findUnique({ where: { accessTokenHash: hashSecret(token) } });
  if (!record || record.revokedAt) return null;
  if (new Date(record.accessTokenExpiresAt).getTime() < Date.now()) return null;
  if (record.resource && record.resource !== normalizeResource(getMcpResourceUrl(req))) return null;
  return await users.findById(record.userId);
}
