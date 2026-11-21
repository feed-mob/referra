import { useMemo } from 'react';
import { AppSidebar } from '../components/common/AppSidebar';
import { API_URL } from '../config/api';

export default function McpDocuments() {
  const endpoint = useMemo(() => `${API_URL}/api/mcp`, []);
  const initializeRequest = `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "clientInfo": { "name": "your-client", "version": "1.0.0" },
    "capabilities": {}
  }
}`;
  const claudeCodeSample = `claude mcp add --transport http ai-referrer ${endpoint}`;
  const clientConfigSample = `{
  "mcpServers": {
    "ai-referrer": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${endpoint}"]
    }
  }
}`;

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#f7f9fb] text-slate-900 antialiased">
      <AppSidebar activeItem="mcp-docs" ariaLabel="Documents Navigation" />

      <main className="relative ml-64 flex min-h-screen flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-slate-100 bg-white px-8">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">MCP Documentation</h1>
            <p className="text-xs text-slate-500">Remote MCP integration and authentication guide</p>
          </div>
        </header>

        <div className="flex-1 space-y-6 p-8">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700">MCP Endpoint</h2>
            <p className="mt-2 rounded-md bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100">{endpoint}</p>
            <p className="mt-2 text-sm text-slate-600">Request method: `POST`, JSON-RPC 2.0.</p>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700">Authentication (OAuth 2.1)</h2>
            <p className="mt-2 text-sm text-slate-600">
              The MCP endpoint is protected with OAuth, following the MCP authorization spec. MCP clients discover the
              authorization server automatically: the first request returns <span className="font-mono text-xs">401</span> with
              a <span className="font-mono text-xs">WWW-Authenticate</span> header, then the client registers itself, opens a
              browser window for you to sign in with Google and approve access, and keeps the access token refreshed.
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600">
              <li>
                Protected resource metadata: <span className="font-mono">{API_URL}/.well-known/oauth-protected-resource/api/mcp</span>
              </li>
              <li>
                Authorization server metadata: <span className="font-mono">{API_URL}/.well-known/oauth-authorization-server</span>
              </li>
              <li>Authorization code flow with PKCE (S256), dynamic client registration, scope <span className="font-mono">mcp</span>.</li>
              <li>Access tokens expire after 1 hour; refresh tokens after 30 days (rotated on every use).</li>
            </ul>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700">Features</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-xs font-semibold text-slate-900">category_attributed_list</p>
                <p className="mt-2 text-sm text-slate-700">
                  Query the Category Attributed task list, mapped from <span className="font-mono text-xs">/api/reports</span>.
                </p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-xs font-semibold text-slate-900">category_attributed_detail</p>
                <p className="mt-2 text-sm text-slate-700">
                  Query detail data of a report by <span className="font-mono text-xs">reportId</span>, mapped from{' '}
                  <span className="font-mono text-xs">/api/reports/:id/detail</span>.
                </p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-xs font-semibold text-slate-900">category_attributed_user_journey_by_uid</p>
                <p className="mt-2 text-sm text-slate-700">
                  Query user journey rows by <span className="font-mono text-xs">reportId + uid</span>, including journey logs and generated doc.
                  Optional args: <span className="font-mono text-xs">generate=true</span>,{' '}
                  <span className="font-mono text-xs">forceRegenerate=false</span>.
                </p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-xs font-semibold text-slate-900">delivery_dashboard</p>
                <p className="mt-2 text-sm text-slate-700">
                  Query Delivery Dashboard data shown on <span className="font-mono text-xs">/dashboard</span>, mapped from{' '}
                  <span className="font-mono text-xs">/api/delivery-dashboard</span>. Optional args:{' '}
                  <span className="font-mono text-xs">startDate</span>, <span className="font-mono text-xs">endDate</span> (YYYY-MM-DD),{' '}
                  <span className="font-mono text-xs">filterId</span>, <span className="font-mono text-xs">lineItemId</span>.
                </p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-xs font-semibold text-slate-900">delivery_dashboard_settings</p>
                <p className="mt-2 text-sm text-slate-700">
                  List configured Click URL IDs and names, mapped from{' '}
                  <span className="font-mono text-xs">/api/delivery-dashboard/settings</span>.
                </p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-xs font-semibold text-slate-900">delivery_dashboard_refresh_logs</p>
                <p className="mt-2 text-sm text-slate-700">
                  List recent metric refresh job logs, mapped from{' '}
                  <span className="font-mono text-xs">/api/delivery-dashboard/refresh/logs</span>. Optional arg:{' '}
                  <span className="font-mono text-xs">limit</span> (default 100).
                </p>
              </article>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700">MCP Usage</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700">
              <li>Complete the OAuth flow and send the access token as `Authorization: Bearer &lt;access_token&gt;`.</li>
              <li>Call `initialize` first, then `notifications/initialized`.</li>
              <li>Call `tools/list` to discover tools.</li>
              <li>
                Call `tools/call` with name `category_attributed_list`, `category_attributed_detail`,
                `category_attributed_user_journey_by_uid`, `delivery_dashboard`, `delivery_dashboard_settings`, or
                `delivery_dashboard_refresh_logs`.
              </li>
            </ol>
            <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{initializeRequest}</pre>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700">Config Samples</h2>
            <p className="mt-2 text-sm text-slate-600">Claude Code (Streamable HTTP, OAuth handled by the client):</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{claudeCodeSample}</pre>
            <p className="mt-4 text-sm text-slate-600">
              Clients that only support stdio servers can use `mcp-remote`, which runs the OAuth flow in your browser:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{clientConfigSample}</pre>
          </section>
        </div>
      </main>
    </div>
  );
}
