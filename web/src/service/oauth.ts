import { buildApiUrl, throwApiError } from './http';

export type OAuthAuthorizeInfo = {
  clientName: string | null;
  redirectUri: string;
  scope: string;
};

type OAuthErrorPayload = { error?: string; error_description?: string };

export const oauthApi = {
  getAuthorizeInfo: async (search: string): Promise<OAuthAuthorizeInfo> => {
    const response = await fetch(buildApiUrl(`/api/oauth/authorize/info${search}`));
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as OAuthErrorPayload | null;
      throw new Error(payload?.error_description || payload?.error || 'Invalid authorization request');
    }
    return response.json();
  },

  decide: async (
    bearerToken: string,
    params: Record<string, string>,
    approve: boolean,
  ): Promise<{ redirectUrl: string }> => {
    const response = await fetch(buildApiUrl('/api/oauth/authorize/decision'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify({ ...params, approve }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as OAuthErrorPayload | null;
      if (payload?.error_description) throw new Error(payload.error_description);
      await throwApiError(response, 'Failed to submit authorization');
    }
    return response.json();
  },
};
