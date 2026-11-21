import { users } from "../../../packages/db/index.js";
import {
  OAuthError,
  authenticateClient,
  buildRedirectUrl,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getAuthorizationServerMetadata,
  getProtectedResourceMetadata,
  getWebAppUrl,
  readAuthorizationRequest,
  readClientCredentials,
  registerClient,
  revokeToken,
  validateAuthorizationParams,
  validateClientRedirect,
} from "../services/mcp-oauth.service.js";

const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };

async function readForm(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body || {})) {
      if (typeof value === "string") form.set(key, value);
    }
    return form;
  }
  return new URLSearchParams(await req.text());
}

function oauthErrorResponse(error: unknown) {
  if (error instanceof OAuthError) {
    return error.toResponse(error.status === 401 ? { "WWW-Authenticate": 'Basic realm="oauth"' } : undefined);
  }
  throw error;
}

/** Web-app user session credential: the per-user bearer token held by the logged-in web app. */
async function authenticateWebUser(req: Request) {
  const header = req.headers.get("authorization")?.trim() || "";
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return await users.findByBearerToken(token.trim());
}

export const oauthController = {
  protectedResourceMetadata(req: Request) {
    return Response.json(getProtectedResourceMetadata(req));
  },

  authorizationServerMetadata(req: Request) {
    return Response.json(getAuthorizationServerMetadata(req));
  },

  async register(req: Request) {
    try {
      const body = await req.json().catch(() => {
        throw new OAuthError("invalid_client_metadata", "Registration body must be valid JSON");
      });
      return Response.json(await registerClient(body), { status: 201, headers: noStore });
    } catch (error) {
      return oauthErrorResponse(error);
    }
  },

  /** Authorization endpoint: validate the request, then hand off to the web app for login + consent. */
  async authorize(req: Request) {
    const url = new URL(req.url);
    const request = readAuthorizationRequest(url.searchParams);

    try {
      await validateClientRedirect(request);
    } catch (error) {
      if (error instanceof OAuthError) {
        return new Response(`OAuth authorization error: ${error.description}`, {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...noStore },
        });
      }
      throw error;
    }

    try {
      validateAuthorizationParams(req, request);
    } catch (error) {
      if (error instanceof OAuthError) {
        return Response.redirect(
          buildRedirectUrl(request.redirectUri, { error: error.error, error_description: error.description, state: request.state }),
          302,
        );
      }
      throw error;
    }

    return Response.redirect(`${getWebAppUrl()}/oauth/authorize?${url.searchParams.toString()}`, 302);
  },

  /** Consent page helper: public client info for an authorization request. */
  async authorizeInfo(req: Request) {
    const request = readAuthorizationRequest(new URL(req.url).searchParams);
    try {
      const client = await validateClientRedirect(request);
      validateAuthorizationParams(req, request);
      return Response.json(
        { clientName: client.clientName || null, redirectUri: request.redirectUri, scope: "mcp" },
        { headers: noStore },
      );
    } catch (error) {
      return oauthErrorResponse(error);
    }
  },

  /** Consent decision from the logged-in web app user. Returns the redirect URL back to the MCP client. */
  async authorizeDecision(req: Request) {
    const user = await authenticateWebUser(req);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const request = readAuthorizationRequest(body);

    try {
      await validateClientRedirect(request);
    } catch (error) {
      return oauthErrorResponse(error);
    }

    if (body.approve !== true) {
      return Response.json(
        {
          redirectUrl: buildRedirectUrl(request.redirectUri, {
            error: "access_denied",
            error_description: "The user denied the request",
            state: request.state,
          }),
        },
        { headers: noStore },
      );
    }

    try {
      const { scope, resource } = validateAuthorizationParams(req, request);
      const code = await createAuthorizationCode({
        clientId: request.clientId,
        userId: user.id,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scope,
        resource,
      });
      return Response.json(
        { redirectUrl: buildRedirectUrl(request.redirectUri, { code, state: request.state }) },
        { headers: noStore },
      );
    } catch (error) {
      if (error instanceof OAuthError) {
        return Response.json(
          {
            redirectUrl: buildRedirectUrl(request.redirectUri, {
              error: error.error,
              error_description: error.description,
              state: request.state,
            }),
          },
          { headers: noStore },
        );
      }
      throw error;
    }
  },

  async token(req: Request) {
    try {
      const form = await readForm(req);
      const client = await authenticateClient(readClientCredentials(req, form));
      const grantType = form.get("grant_type")?.trim() || "";

      const tokens =
        grantType === "authorization_code"
          ? await exchangeAuthorizationCode(req, form, client.clientId)
          : grantType === "refresh_token"
            ? await exchangeRefreshToken(req, form, client.clientId)
            : (() => {
                throw new OAuthError("unsupported_grant_type", `Unsupported grant_type: ${grantType || "(empty)"}`);
              })();

      return Response.json(tokens, { headers: noStore });
    } catch (error) {
      return oauthErrorResponse(error);
    }
  },

  async revoke(req: Request) {
    try {
      const form = await readForm(req);
      const client = await authenticateClient(readClientCredentials(req, form));
      await revokeToken(form.get("token")?.trim() || "", client.clientId);
      // RFC 7009: respond 200 even if the token was unknown.
      return new Response(null, { status: 200, headers: noStore });
    } catch (error) {
      return oauthErrorResponse(error);
    }
  },
};
