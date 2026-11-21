import { logs, referrerRaws, reports, users } from "../../../packages/db/index.js";
import { normalizeAttributionLogicMapping } from "../config/attribution.config.js";
import { getDeliveryDashboard, listDeliveryRefreshLogs } from "../services/delivery-dashboard.service.js";
import { getDeliveryMetricFilterSettings } from "../services/delivery-metric-settings.service.js";
import { getReportDetailPayload } from "../services/reports-detail.service.js";
import { generateUserJourneyDocFromLogs } from "../services/reports-user-journey.service.js";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

const MCP_TOOL_NAME_LIST = "category_attributed_list";
const MCP_TOOL_NAME_DETAIL = "category_attributed_detail";
const MCP_TOOL_NAME_USER_JOURNEY_BY_UID = "category_attributed_user_journey_by_uid";
const MCP_TOOL_NAME_DELIVERY_DASHBOARD = "delivery_dashboard";
const MCP_TOOL_NAME_DELIVERY_DASHBOARD_SETTINGS = "delivery_dashboard_settings";
const MCP_TOOL_NAME_DELIVERY_DASHBOARD_REFRESH_LOGS = "delivery_dashboard_refresh_logs";
const MCP_PROTOCOL_VERSION = "2024-11-05";

const mcpTools: McpTool[] = [
  {
    name: MCP_TOOL_NAME_LIST,
    description: "Query Category Attributed report task list.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Optional report task status filter, e.g. Running / Completed / Failed / Paused.",
        },
        client: {
          type: "string",
          description: "Optional client name filter.",
        },
        search: {
          type: "string",
          description: "Optional keyword filter for task name, rule id, report id, and client name.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max returned rows. Default 50.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_NAME_DETAIL,
    description: "Query Category Attributed report detail by report id.",
    inputSchema: {
      type: "object",
      properties: {
        reportId: {
          type: "string",
          description: "Required report task id.",
        },
        page: {
          type: "integer",
          minimum: 1,
          description: "Optional page number. Default 1.",
        },
        pageSize: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Optional page size. Default 50.",
        },
        startDate: {
          type: "string",
          description: "Optional start date filter, format YYYY-MM-DD.",
        },
        endDate: {
          type: "string",
          description: "Optional end date filter, format YYYY-MM-DD.",
        },
        referrerType: {
          type: "string",
          description: "Optional referrer_type filter.",
        },
        cohortMode: {
          type: "string",
          enum: ["non-cohort", "cohort"],
          description: "Optional cohort mode. Default non-cohort.",
        },
        windowHours: {
          type: "number",
          description: "Optional duration filter: event_time - source_time <= windowHours.",
        },
        impressionToFirstPageLoadHours: {
          type: "number",
          description: "Optional duration filter: first_page_load_time - source_time <= value.",
        },
        firstPageLoadToRegistrationHours: {
          type: "number",
          description: "Optional duration filter: event_time - first_page_load_time <= value.",
        },
        durationFilterOperator: {
          type: "string",
          enum: ["and", "or"],
          description: "Duration filters combine operator. Default and.",
        },
      },
      required: ["reportId"],
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_NAME_USER_JOURNEY_BY_UID,
    description: "Query user journey in a Category Attributed report by report id and uid.",
    inputSchema: {
      type: "object",
      properties: {
        reportId: {
          type: "string",
          description: "Required report task id.",
        },
        uid: {
          type: "string",
          description: "Required uid in report rows.",
        },
        generate: {
          type: "boolean",
          description: "Optional. Default true. Generate user journey doc when missing.",
        },
        forceRegenerate: {
          type: "boolean",
          description: "Optional. Default false. Regenerate even if doc already exists.",
        },
      },
      required: ["reportId", "uid"],
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_NAME_DELIVERY_DASHBOARD,
    description:
      "Query Delivery Dashboard data (same as the /dashboard page): impressions, installs, IPM, bid requests/bids, hourly series, period comparison, bid reasons, bid prices, top DMA and creatives.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Optional start date (UTC), format YYYY-MM-DD. Default today.",
        },
        endDate: {
          type: "string",
          description: "Optional end date (UTC, inclusive), format YYYY-MM-DD. Default startDate.",
        },
        filterId: {
          type: "integer",
          minimum: 0,
          description: "Optional Click URL ID. Use delivery_dashboard_settings to list configured ids. Default all configured Click URL IDs.",
        },
        lineItemId: {
          type: "string",
          description: "Optional line item (ADSET_ID) filter. Requires filterId; bid prices are only returned when set.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_NAME_DELIVERY_DASHBOARD_SETTINGS,
    description: "List Delivery Dashboard configured Click URL IDs, their names, and whether bid metrics are shown.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_NAME_DELIVERY_DASHBOARD_REFRESH_LOGS,
    description: "List recent Delivery Dashboard metric refresh job logs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Max returned rows. Default 100.",
        },
      },
      additionalProperties: false,
    },
  },
];

function toJsonRpcResult(id: JsonRpcId | undefined, result: unknown) {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  });
}

function toJsonRpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code,
        message,
        data,
      },
    },
    { status: 400 },
  );
}

function readBearerToken(req: Request) {
  const header = req.headers.get("authorization")?.trim();
  if (!header) return "";

  const [scheme, token] = header.split(/\s+/, 2);
  if (!scheme || !token) return "";
  if (scheme.toLowerCase() !== "bearer") return "";

  return token.trim();
}

async function authenticate(req: Request) {
  const token = readBearerToken(req);
  if (!token) return null;

  return await users.findByBearerToken(token);
}

function normalizeToolArgs(raw: unknown) {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const status = typeof value.status === "string" ? value.status.trim() : "";
  const client = typeof value.client === "string" ? value.client.trim() : "";
  const search = typeof value.search === "string" ? value.search.trim() : "";
  const limitRaw = Number(value.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;

  return {
    status,
    client,
    search,
    limit,
  };
}

async function callCategoryAttributedListTool(args: unknown) {
  const normalized = normalizeToolArgs(args);
  const items = await reports.list({
    status: normalized.status || undefined,
    client: normalized.client || undefined,
    search: normalized.search || undefined,
  });

  const rows = (items as Array<any>).slice(0, normalized.limit).map((item) => ({
    id: String(item.id),
    taskName: String(item.taskName || ""),
    client: String(item.client?.name || ""),
    status: String(item.status || ""),
    progress: Number(item.progress || 0),
    progressLabel: String(item.progressLabel || ""),
    attribution: String(item.attribution || ""),
    ruleId: String(item.ruleId || ""),
    reportType: String(item.reportType || ""),
    source: String(item.source || ""),
    createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : String(item.createdAt || ""),
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(rows, null, 2),
      },
    ],
    structuredContent: {
      items: rows,
      total: rows.length,
      filters: {
        status: normalized.status || null,
        client: normalized.client || null,
        search: normalized.search || null,
        limit: normalized.limit,
      },
    },
  };
}

function normalizeDetailArgs(raw: unknown) {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const reportId = typeof value.reportId === "string" ? value.reportId.trim() : "";
  const pageRaw = Number(value.page);
  const pageSizeRaw = Number(value.pageSize);
  const windowHoursRaw = Number(value.windowHours);
  const impressionToFirstPageLoadHoursRaw = Number(value.impressionToFirstPageLoadHours);
  const firstPageLoadToRegistrationHoursRaw = Number(value.firstPageLoadToRegistrationHours);
  const durationFilterOperatorRaw =
    typeof value.durationFilterOperator === "string" ? value.durationFilterOperator.trim().toLowerCase() : "";
  const durationFilterOperator: "and" | "or" = durationFilterOperatorRaw === "or" ? "or" : "and";
  const startDate = typeof value.startDate === "string" ? value.startDate.trim() : "";
  const endDate = typeof value.endDate === "string" ? value.endDate.trim() : "";
  const referrerType = typeof value.referrerType === "string" ? value.referrerType.trim() : "";
  const cohortModeRaw = typeof value.cohortMode === "string" ? value.cohortMode.trim().toLowerCase() : "";
  const cohortMode: "non-cohort" | "cohort" = cohortModeRaw === "cohort" ? "cohort" : "non-cohort";
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(200, Math.floor(pageSizeRaw)) : 50;

  return {
    reportId,
    page,
    pageSize,
    startDate,
    endDate,
    referrerType,
    cohortMode,
    windowHours: Number.isFinite(windowHoursRaw) ? windowHoursRaw : undefined,
    impressionToFirstPageLoadHours: Number.isFinite(impressionToFirstPageLoadHoursRaw)
      ? impressionToFirstPageLoadHoursRaw
      : undefined,
    firstPageLoadToRegistrationHours: Number.isFinite(firstPageLoadToRegistrationHoursRaw)
      ? firstPageLoadToRegistrationHoursRaw
      : undefined,
    durationFilterOperator,
  };
}

async function callCategoryAttributedDetailTool(args: unknown) {
  const normalized = normalizeDetailArgs(args);
  if (!normalized.reportId) {
    throw new Error("reportId is required");
  }

  const current = await reports.findById(normalized.reportId);
  if (!current) {
    throw new Error("Report task not found");
  }

  const payload = await getReportDetailPayload(current, {
    page: normalized.page,
    pageSize: normalized.pageSize,
    startDate: normalized.startDate || undefined,
    endDate: normalized.endDate || undefined,
    referrerType: normalized.referrerType || undefined,
    cohortMode: normalized.cohortMode,
    windowHours: normalized.windowHours,
    impressionToFirstPageLoadHours: normalized.impressionToFirstPageLoadHours,
    firstPageLoadToRegistrationHours: normalized.firstPageLoadToRegistrationHours,
    durationFilterOperator: normalized.durationFilterOperator,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function readStringValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizeUserJourneyByUidArgs(raw: unknown) {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const reportId = typeof value.reportId === "string" ? value.reportId.trim() : "";
  const uid = typeof value.uid === "string" ? value.uid.trim() : "";
  const generate = typeof value.generate === "boolean" ? value.generate : true;
  const forceRegenerate = typeof value.forceRegenerate === "boolean" ? value.forceRegenerate : false;
  return {
    reportId,
    uid,
    generate,
    forceRegenerate,
  };
}

async function callCategoryAttributedUserJourneyByUidTool(args: unknown) {
  const normalized = normalizeUserJourneyByUidArgs(args);
  if (!normalized.reportId) {
    throw new Error("reportId is required");
  }
  if (!normalized.uid) {
    throw new Error("uid is required");
  }

  const current = await reports.findById(normalized.reportId);
  if (!current) {
    throw new Error("Report task not found");
  }

  const rows = await referrerRaws.listByReportAndUid(current.id, normalized.uid);
  const attributionLogic = normalizeAttributionLogicMapping(current.fieldMappings);
  const sourceUrlField = attributionLogic?.source_url || "";
  const sourceTimeField = attributionLogic?.source_time || "";
  const eventTimeField = attributionLogic?.event_time || "";
  const journeys = [];
  for (const item of rows as Array<any>) {
    const json = item?.json && typeof item.json === "object" && !Array.isArray(item.json) ? (item.json as Record<string, unknown>) : {};
    const sourceUrl = sourceUrlField ? readStringValue(json, [sourceUrlField]) : "";
    const sourceTime = sourceTimeField ? readStringValue(json, [sourceTimeField]) : "";
    const eventTime = eventTimeField ? readStringValue(json, [eventTimeField]) : "";
    const existingDoc =
      typeof item.userJourneyDoc === "string" && item.userJourneyDoc.trim() ? item.userJourneyDoc.trim() : "";
    let userJourneyDoc = existingDoc;
    let generationError = "";

    const shouldGenerate =
      normalized.generate && (normalized.forceRegenerate || !userJourneyDoc);
    if (shouldGenerate) {
      try {
        userJourneyDoc = await generateUserJourneyDocFromLogs((item as { journeyLogs?: unknown }).journeyLogs, {
          sourceUrl,
          sourceTime,
          eventTime,
        });
        await referrerRaws.updateUserJourneyDoc({
          id: String(item.id),
          reportId: current.id,
          userJourneyDoc,
        });
        await logs.createMany([
          {
            reportId: current.id,
            level: "info",
            message: `user_journey_doc generated for referrer_raw=${String(item.id)} via mcp_uid_query`,
          },
        ]);
      } catch (error) {
        generationError = error instanceof Error ? error.message : String(error);
      }
    }

    const journeyLogs = Array.isArray(item?.journeyLogs) ? item.journeyLogs : [];
    journeys.push({
      rawId: String(item.id || ""),
      uid: typeof item.uid === "string" ? item.uid : normalized.uid,
      referrerType: String(item.referrerType || ""),
      referrerDesc: String(item.referrerDesc || ""),
      durationSeconds: Number(item.duration || 0),
      sourceTime,
      eventTime,
      firstPageLoadDurationSeconds:
        typeof item.firstPageLoadDuration === "number" && Number.isFinite(item.firstPageLoadDuration)
          ? item.firstPageLoadDuration
          : null,
      userJourneyDoc,
      generationError: generationError || null,
      journeyLogsCount: journeyLogs.length,
      journeyLogs,
    });
  }

  const payload = {
    reportId: current.id,
    uid: normalized.uid,
    generate: normalized.generate,
    forceRegenerate: normalized.forceRegenerate,
    total: journeys.length,
    journeys,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function toToolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function normalizeDashboardDate(value: unknown, name: string, fallback: string) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`${name} must use YYYY-MM-DD format`);
  }
  const date = value.trim();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${name} must be a valid calendar date`);
  }
  return date;
}

async function callDeliveryDashboardTool(args: unknown) {
  const value = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const startDate = normalizeDashboardDate(value.startDate, "startDate", new Date().toISOString().slice(0, 10));
  const endDate = normalizeDashboardDate(value.endDate, "endDate", startDate);
  if (endDate < startDate) throw new Error("endDate must be on or after startDate");

  let filterId: number | undefined;
  if (value.filterId !== undefined && value.filterId !== null && value.filterId !== "") {
    const parsed = Number(value.filterId);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("filterId must be a non-negative integer");
    filterId = parsed;
  }
  const lineItemId =
    typeof value.lineItemId === "string" || typeof value.lineItemId === "number"
      ? String(value.lineItemId).trim() || undefined
      : undefined;

  const payload = await getDeliveryDashboard(startDate, endDate, filterId, lineItemId);
  return toToolResult({ startDate, endDate, ...payload });
}

async function callDeliveryDashboardSettingsTool() {
  return toToolResult(await getDeliveryMetricFilterSettings());
}

async function callDeliveryDashboardRefreshLogsTool(args: unknown) {
  const value = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const limitRaw = Number(value.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100;
  const items = await listDeliveryRefreshLogs(limit);
  return toToolResult({ items, total: items.length });
}

const mcpToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {
  [MCP_TOOL_NAME_LIST]: callCategoryAttributedListTool,
  [MCP_TOOL_NAME_DETAIL]: callCategoryAttributedDetailTool,
  [MCP_TOOL_NAME_USER_JOURNEY_BY_UID]: callCategoryAttributedUserJourneyByUidTool,
  [MCP_TOOL_NAME_DELIVERY_DASHBOARD]: callDeliveryDashboardTool,
  [MCP_TOOL_NAME_DELIVERY_DASHBOARD_SETTINGS]: callDeliveryDashboardSettingsTool,
  [MCP_TOOL_NAME_DELIVERY_DASHBOARD_REFRESH_LOGS]: callDeliveryDashboardRefreshLogsTool,
};

export const mcpController = {
  async remote(req: Request) {
    const user = await authenticate(req);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let payload: JsonRpcRequest;

    try {
      payload = (await req.json()) as JsonRpcRequest;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
      return toJsonRpcError(payload?.id, -32600, "Invalid Request");
    }

    if (payload.method === "initialize") {
      return toJsonRpcResult(payload.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: "ai-referrer-remote-mcp",
          version: "0.1.0",
        },
      });
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }

    if (payload.method === "ping") {
      return toJsonRpcResult(payload.id, {});
    }

    if (payload.method === "tools/list") {
      return toJsonRpcResult(payload.id, {
        tools: mcpTools,
      });
    }

    if (payload.method === "tools/call") {
      const params = (payload.params || {}) as {
        name?: unknown;
        arguments?: unknown;
      };
      const toolName = typeof params.name === "string" ? params.name.trim() : "";

      const handler = Object.hasOwn(mcpToolHandlers, toolName) ? mcpToolHandlers[toolName] : undefined;
      if (!handler) {
        return toJsonRpcError(payload.id, -32601, `Unknown tool: ${toolName || "(empty)"}`);
      }

      try {
        const result = await handler(params.arguments);
        return toJsonRpcResult(payload.id, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toJsonRpcError(payload.id, -32000, `Tool execution failed: ${message}`);
      }
    }

    return toJsonRpcError(payload.id, -32601, `Method not found: ${payload.method}`);
  },
};
