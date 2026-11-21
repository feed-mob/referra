import { oauthController } from "../controllers/index.js";

export const oauthRoutes = {
  "/.well-known/oauth-protected-resource": {
    GET: oauthController.protectedResourceMetadata,
  },
  "/.well-known/oauth-protected-resource/api/mcp": {
    GET: oauthController.protectedResourceMetadata,
  },
  "/.well-known/oauth-authorization-server": {
    GET: oauthController.authorizationServerMetadata,
  },
  "/oauth/register": {
    POST: oauthController.register,
  },
  "/oauth/authorize": {
    GET: oauthController.authorize,
  },
  "/oauth/token": {
    POST: oauthController.token,
  },
  "/oauth/revoke": {
    POST: oauthController.revoke,
  },
  "/api/oauth/authorize/info": {
    GET: oauthController.authorizeInfo,
  },
  "/api/oauth/authorize/decision": {
    POST: oauthController.authorizeDecision,
  },
};
