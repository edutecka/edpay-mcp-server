import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, keySetupInstructions, type EdPayCredentials } from "./index.js";

const port = Number.parseInt(process.env.EDPAY_MCP_PORT ?? "23883", 10);
const allowedHosts = new Set(
  (process.env.EDPAY_MCP_ALLOWED_HOSTS ?? "api-pay.edutecka.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);
const allowedOrigins = new Set(
  (process.env.EDPAY_MCP_ALLOWED_ORIGINS ?? "https://api-pay.edutecka.com")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const maxConcurrentRequests = 32;
let activeRequests = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(payload);
}

function hostIsAllowed(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  if (!hostHeader || hostHeader.length > 255) return false;
  try {
    const host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return allowedHosts.has(host);
  } catch {
    return false;
  }
}

function originIsAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || (typeof origin === "string" && allowedOrigins.has(origin));
}

function getSingleHeader(req: IncomingMessage, name: string): string | undefined | null {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(req.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length > 1) return null;
  if (values.length === 0) return undefined;
  return values[0];
}

function readCredentials(req: IncomingMessage): EdPayCredentials | null {
  const publicKey = getSingleHeader(req, "X-EDPay-Public-Key");
  const privateKey = getSingleHeader(req, "X-EDPay-Private-Key");
  if (publicKey === null || privateKey === null) return null;
  if (publicKey === undefined && privateKey === undefined) return {};
  if ((publicKey?.length ?? 0) > 512 || (privateKey?.length ?? 0) > 512) return null;

  // Do not decide whether a candidate key is valid here. Forward it to the
  // partner API so its existing pair validator records mismatches and failures.
  return { publicKey: publicKey ?? "", privateKey: privateKey ?? "" };
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("Allow", allow);
  sendJson(res, 405, { error: "method_not_allowed" });
}

const httpServer = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (!hostIsAllowed(req)) {
    sendJson(res, 403, { error: "host_not_allowed" });
    return;
  }
  if (!originIsAllowed(req)) {
    sendJson(res, 403, { error: "origin_not_allowed" });
    return;
  }

  let pathname: string;
  let requestUrl: URL;
  try {
    requestUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
    pathname = requestUrl.pathname;
  } catch {
    sendJson(res, 400, { error: "invalid_request_target" });
    return;
  }
  if (requestUrl.search) {
    sendJson(res, 400, { error: "query_not_allowed" });
    return;
  }

  if (pathname === "/mcp/setup") {
    if (req.method !== "GET") {
      methodNotAllowed(res, "GET");
      return;
    }
    sendJson(res, 200, keySetupInstructions);
    return;
  }

  if (pathname !== "/mcp") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (req.method !== "POST") {
    methodNotAllowed(res, "POST");
    return;
  }
  if (activeRequests >= maxConcurrentRequests) {
    sendJson(res, 503, { error: "server_busy" });
    return;
  }

  const credentials = readCredentials(req);
  if (!credentials) {
    sendJson(res, 400, { error: "invalid_edpay_key_pair", message: "Provide both EDPay keys from the same environment, or omit both for read-only access." });
    return;
  }

  activeRequests += 1;
  const server = createMcpServer(credentials);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 64 * 1024,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: "mcp_request_failed" });
    else if (!res.writableEnded) res.end();
  } finally {
    activeRequests -= 1;
    await server.close().catch(() => undefined);
  }
});

httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 30_000;
httpServer.keepAliveTimeout = 5_000;
httpServer.maxHeadersCount = 64;
httpServer.maxConnections = 128;
httpServer.listen(port, process.env.EDPAY_MCP_BIND_HOST ?? "127.0.0.1");
