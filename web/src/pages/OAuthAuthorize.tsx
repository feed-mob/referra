import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { oauthApi, type OAuthAuthorizeInfo } from '../service/oauth';

const FORWARDED_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const;

export default function OAuthAuthorize() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [info, setInfo] = useState<OAuthAuthorizeInfo | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const params = useMemo(() => {
    const search = new URLSearchParams(location.search);
    const result: Record<string, string> = {};
    FORWARDED_PARAMS.forEach((key) => {
      const value = search.get(key);
      if (value) result[key] = value;
    });
    return result;
  }, [location.search]);

  useEffect(() => {
    let cancelled = false;
    oauthApi
      .getAuthorizeInfo(location.search)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Invalid authorization request');
      });
    return () => {
      cancelled = true;
    };
  }, [location.search]);

  async function decide(approve: boolean) {
    if (!user) return;
    setSubmitting(true);
    setError('');
    try {
      const { redirectUrl } = await oauthApi.decide(user.bearerToken, params, approve);
      window.location.assign(redirectUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to submit authorization');
      setSubmitting(false);
    }
  }

  const clientName = info?.clientName || 'An MCP client';
  const redirectHost = (() => {
    if (!info?.redirectUri) return '';
    try {
      const url = new URL(info.redirectUri);
      return url.host || url.protocol;
    } catch {
      return info.redirectUri;
    }
  })();

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f7f9fb] px-4 text-slate-900">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Authorize MCP access</h1>

        {error ? (
          <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>
        ) : !info ? (
          <p className="mt-4 text-sm text-slate-500">Loading authorization request…</p>
        ) : (
          <>
            <p className="mt-4 text-sm text-slate-700">
              <span className="font-semibold">{clientName}</span> wants to access AI Referrer data on your behalf through MCP
              (Category Attributed reports and Delivery Dashboard, read-only).
            </p>
            <dl className="mt-4 space-y-2 rounded-md bg-slate-50 p-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Signed in as</dt>
                <dd className="truncate font-medium text-slate-900">{user?.email}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Redirects to</dt>
                <dd className="truncate font-mono text-slate-900">{redirectHost}</dd>
              </div>
            </dl>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={submitting}
                onClick={() => void decide(false)}
                className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50"
              >
                Deny
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void decide(true)}
                className="flex-1 rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:opacity-50"
              >
                {submitting ? 'Authorizing…' : 'Allow'}
              </button>
            </div>
          </>
        )}

        <button
          type="button"
          onClick={logout}
          className="mt-4 text-xs text-slate-500 underline-offset-2 hover:underline"
        >
          Not you? Sign out
        </button>
      </div>
    </div>
  );
}
