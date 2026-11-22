import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse } from "yaml";
import { z } from "zod";

type Operation = {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
  [key: string]: any;
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const openApiPath = path.join(repositoryRoot, "openapi/v1.yaml");
const openApiText = await readFile(openApiPath, "utf8");
const openApi = parse(openApiText) as { paths?: Record<string, Record<string, any>>; security?: any[] };
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

function listOperations(): Operation[] {
  return Object.entries(openApi.paths ?? {}).flatMap(([route, pathItem]) =>
    Object.entries(pathItem ?? {})
      .filter(([method, value]) => httpMethods.has(method.toLowerCase()) && value && typeof value === "object")
      .map(([method, operation]) => ({ ...operation, method: method.toUpperCase(), path: route }))
  );
}

function getOperation(method: string, route: string): Operation | undefined {
  return listOperations().find(
    (operation) => operation.method === method.toUpperCase() && operation.path === route
  );
}

function result(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

type ApiResult =
  | { ok: true; status: number; body: Record<string, any>; environment: "sandbox" | "production" }
  | { ok: false; status?: number; code: string; message: string; requestId?: string };

export type EdPayCredentials = {
  publicKey?: string;
  privateKey?: string;
};

export const keySetupInstructions = {
  dashboard_url: "https://pay.edutecka.com/dashboard/mcp",
  steps: [
    "Sign in to the EDPay dashboard and open Developers → EDPay MCP.",
    "Choose the account and environment, then create a credential with the invoices:write scope.",
    "Copy the one-time X-EDPay-MCP-Key value into your MCP client's secure secret store.",
  ],
  environments: {
    sandbox: { public_key_prefix: "pk_test_", private_key_prefix: "sk_test_" },
    production: { public_key_prefix: "pk_live_", private_key_prefix: "sk_live_" },
  },
  endpoint: "https://api-pay.edutecka.com/v1/mcp",
  headers: ["X-EDPay-MCP-Key"],
  credential_notice: "The one-time MCP value packages the account's existing public/private API key pair. It has the same scopes and revocation as that pair.",
  security_notice: "Treat X-EDPay-MCP-Key as a private credential. Never paste it into chat, prompts, tool arguments, URLs, browser code, repositories, or logs.",
};

const invoiceInput = {
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a three-letter currency code."),
  customer_id: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Description cannot contain control characters.").optional(),
  due_at: z.string().datetime({ offset: true }).optional(),
  due_days: z.number().int().min(0).max(365).optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(500).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Item description cannot contain control characters."),
    quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    unit_amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).max(100),
};

const idempotencyKey = z.string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use 16–128 stable alphanumeric, dot, underscore, colon, or hyphen characters.");

function configuredApi(credentials: EdPayCredentials): { baseUrl: URL; publicKey: string; privateKey: string; mode: "test" | "live" } | ApiResult {
  const publicKey = credentials.publicKey ?? "";
  const privateKey = credentials.privateKey ?? "";
  if (credentials.publicKey === undefined && credentials.privateKey === undefined) {
    return { ok: false, code: "edpay_keys_missing", message: "Configure the X-EDPay-MCP-Key credential from the EDPay dashboard in the MCP client's secure secret store. Call edpay_get_key_setup for instructions; tool arguments never accept credentials." };
  }
  // Forward every structurally received candidate pair to the partner API.
  // Its existing validator owns format, environment, failure tracking, and alerts.
  const mode = publicKey.startsWith("pk_live_") || privateKey.startsWith("sk_live_") ? "live" : "test";

  let baseUrl: URL;
  try {
    baseUrl = new URL(process.env.EDPAY_API_BASE_URL?.trim() || "https://api-pay.edutecka.com");
  } catch {
    return { ok: false, code: "edpay_api_url_invalid", message: "EDPAY_API_BASE_URL must be a valid HTTPS origin." };
  }
  const allowedHosts = new Set(
    (process.env.EDPAY_API_ALLOWED_HOSTS || "api-pay.edutecka.com")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
  if (
    baseUrl.protocol !== "https:" ||
    !allowedHosts.has(baseUrl.hostname.toLowerCase()) ||
    (baseUrl.port && baseUrl.port !== "443") ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.username ||
    baseUrl.password
  ) {
    return { ok: false, code: "edpay_api_url_not_allowed", message: "EDPAY_API_BASE_URL must be an HTTPS origin whose hostname is listed in EDPAY_API_ALLOWED_HOSTS." };
  }
  return { baseUrl, publicKey, privateKey, mode };
}

async function readResponseText(response: Response, maxBytes = 256 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("EDPay response exceeded the MCP size limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function callInvoiceApi(
  route: string,
  method: "POST",
  body: unknown,
  key: string | undefined,
  credentials: EdPayCredentials,
): Promise<ApiResult> {
  const config = configuredApi(credentials);
  if ("ok" in config) return config;
  const url = new URL(route, config.baseUrl);
  try {
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-EDPay-Public-Key": config.publicKey,
        "X-EDPay-Private-Key": config.privateKey,
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
    const raw = await readResponseText(response);
    let parsed: any;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      return { ok: false, status: response.status, code: "edpay_invalid_response", message: "EDPay returned a response that was not valid JSON." };
    }
    const requestId = typeof parsed?.meta?.request_id === "string" ? parsed.meta.request_id.slice(0, 128) : undefined;
    if (!response.ok) {
      const error = parsed?.error;
      const code = typeof error?.code === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(error.code)
        ? error.code
        : `http_${response.status}`;
      const message = typeof error?.message === "string"
        ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)
        : "EDPay could not complete the request.";
      return { ok: false, status: response.status, code, message, ...(requestId ? { requestId } : {}) };
    }
    return {
      ok: true,
      status: response.status,
      body: parsed,
      environment: config.mode === "test" ? "sandbox" : "production",
    };
  } catch {
    return { ok: false, code: "edpay_request_failed", message: "EDPay could not be reached or its response was too large. No credentials or request data were logged." };
  }
}

function invoiceFromResponse(response: ApiResult): Record<string, any> | undefined {
  if (!response.ok) return undefined;
  const invoice = response.body?.data?.invoice;
  return invoice && typeof invoice === "object" && !Array.isArray(invoice) ? invoice : undefined;
}

function summarizeInvoice(invoice: Record<string, any>) {
  return {
    id: typeof invoice.id === "string" ? invoice.id : undefined,
    number: typeof invoice.number === "string" ? invoice.number : undefined,
    status: typeof invoice.status === "string" ? invoice.status : undefined,
    currency: typeof invoice.currency === "string" ? invoice.currency : undefined,
    total_minor: Number.isSafeInteger(invoice.total_minor) ? invoice.total_minor : undefined,
    payment_link_id: typeof invoice.payment_link_id === "string" ? invoice.payment_link_id : undefined,
    checkout_url: typeof invoice.checkout_url === "string" && isSafeCheckoutUrl(invoice.checkout_url) ? invoice.checkout_url : null,
  };
}

function isSafeCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash;
  } catch {
    return false;
  }
}

function errorResult(error: Extract<ApiResult, { ok: false }>) {
  return result(JSON.stringify({ error: { status: error.status, code: error.code, message: error.message }, ...(error.requestId ? { request_id: error.requestId } : {}) }, null, 2), true);
}

function envName(value: string): string | undefined {
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
  return match?.[1];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pythonLiteral(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item)}`).join(", ")}}`;
  }
  return "None";
}

function phpSingleQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function createMcpServer(credentials: EdPayCredentials = {}): McpServer {
const server = new McpServer({ name: "edpay-integration-helper", version: "0.1.0" });

server.tool(
  "edpay_get_key_setup",
  "Get unauthenticated instructions for creating EDPay API keys and securely configuring them in this MCP client. This never returns key values.",
  {},
  async () => result(JSON.stringify(keySetupInstructions, null, 2))
);

server.tool(
  "edpay_list_operations",
  "List EDPay API operations, optionally filtered by route, summary, or tag.",
  { query: z.string().optional() },
  async ({ query }) => {
    const normalizedQuery = query?.trim().toLowerCase();
    const operations = listOperations()
      .filter((operation) =>
        !normalizedQuery ||
        `${operation.method} ${operation.path} ${operation.summary ?? ""} ${(operation.tags ?? []).join(" ")}`
          .toLowerCase()
          .includes(normalizedQuery)
      )
      .map(({ method, path: route, summary, tags }) => ({ method, path: route, summary, tags }));
    return result(JSON.stringify(operations, null, 2));
  }
);

server.tool(
  "edpay_get_operation",
  "Read an operation's OpenAPI parameters, authentication, request body, and response definitions.",
  { method: z.string(), path: z.string() },
  async ({ method, path: route }) => {
    const operation = getOperation(method, route);
    return operation
      ? result(JSON.stringify(operation, null, 2))
      : result(`Operation not found: ${method.toUpperCase()} ${route}`, true);
  }
);

server.tool(
  "edpay_generate_snippet",
  "Generate a server-side request starter for a documented EDPay operation. API keys are referenced from environment variables.",
  {
    method: z.string(),
    path: z.string(),
    language: z.enum(["curl", "javascript", "python", "php", "java"]),
    body: z.string().optional(),
  },
  async ({ method, path: route, language, body }) => {
    const normalizedMethod = method.toUpperCase();
    const operation = getOperation(normalizedMethod, route);
    if (!operation) return result(`Operation not found: ${normalizedMethod} ${route}`, true);

    let parsedBody: unknown;
    if (body !== undefined) {
      try {
        parsedBody = JSON.parse(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid JSON";
        return result(`The body argument must be valid JSON: ${message}`, true);
      }
    }

    const url = `https://api-pay.edutecka.com${route.replace(/\{([^}]+)\}/g, "<$1>")}`;
    const security = operation.security ?? openApi.security ?? [];
    const securitySchemes = new Set<string>(
      security.flatMap((requirement: Record<string, unknown>) => Object.keys(requirement))
    );
    const headers: Array<[string, string]> = [["Accept", "application/json"]];

    if (securitySchemes.has("EdPayPublicKey")) {
      headers.push(["X-EDPay-Public-Key", "${EDPAY_PUBLIC_KEY}"]);
    }
    if (securitySchemes.has("EdPayPrivateKey")) {
      headers.push(["X-EDPay-Private-Key", "${EDPAY_PRIVATE_KEY}"]);
    }
    for (const parameter of operation.parameters ?? []) {
      if (parameter.in === "header" && parameter.required) {
        const name = parameter.name as string;
        const variable = `EDPAY_${name.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
        headers.push([name, "${" + variable + "}"]);
      }
    }
    if (operation.requestBody) headers.push(["Content-Type", "application/json"]);

    const jsonBody = parsedBody === undefined ? undefined : JSON.stringify(parsedBody, null, 2);
    const curlHeaderLines = headers.map(([name, value]) => {
      const variable = envName(value);
      return variable
        ? `-H "${name}: $${variable}"`
        : `-H ${shellQuote(`${name}: ${value}`)}`;
    });
    const curlLines = [`curl -X ${normalizedMethod} ${shellQuote(url)}`, ...curlHeaderLines];
    if (jsonBody !== undefined) curlLines.push(`--data-raw ${shellQuote(jsonBody)}`);
    const curlSnippet = curlLines.join(" \\\n  ");

    const jsHeaders = headers
      .map(([name, value]) => {
        const variable = envName(value);
        return `  ${JSON.stringify(name)}: ${variable ? `process.env.${variable}` : JSON.stringify(value)}`;
      })
      .join(",\n");
    const jsSnippet = `const response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(normalizedMethod)},\n  headers: {\n${jsHeaders}\n  }${jsonBody === undefined ? "" : `,\n  body: JSON.stringify(${JSON.stringify(parsedBody, null, 2)})`}\n});\nconst result = await response.json();\nconsole.log(response.status, result);`;

    const pythonHeaders = headers
      .map(([name, value]) => {
        const variable = envName(value);
        return `    ${JSON.stringify(name)}: ${variable ? `os.environ[${JSON.stringify(variable)}]` : JSON.stringify(value)}`;
      })
      .join(",\n");
    const pythonBody = jsonBody === undefined ? "" : `, json=${pythonLiteral(parsedBody)}`;
    const pythonSnippet = `import os\nimport requests\n\nheaders = {\n${pythonHeaders}\n}\nresponse = requests.${normalizedMethod.toLowerCase()}(${JSON.stringify(url)}, headers=headers${pythonBody})\nprint(response.status_code, response.json())`;

    const phpHeaders = headers
      .map(([name, value]) => {
        const variable = envName(value);
        return `    ${JSON.stringify(name + ": ")} . ${variable ? `getenv(${JSON.stringify(variable)})` : JSON.stringify(value)}`;
      })
      .join(",\n");
    const phpBody = jsonBody === undefined
      ? ""
      : `,\n    CURLOPT_POSTFIELDS => json_encode(json_decode('${phpSingleQuoted(jsonBody)}', true, 512, JSON_THROW_ON_ERROR), JSON_THROW_ON_ERROR)`;
    const phpSnippet = `<?php\n$headers = [\n${phpHeaders}\n];\n$ch = curl_init(${JSON.stringify(url)});\ncurl_setopt_array($ch, [\n    CURLOPT_CUSTOMREQUEST => ${JSON.stringify(normalizedMethod)},\n    CURLOPT_RETURNTRANSFER => true,\n    CURLOPT_HTTPHEADER => $headers${phpBody}\n]);\n$response = curl_exec($ch);\n$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);\ncurl_close($ch);\necho $status . ": " . $response;`;

    const javaHeaders = headers
      .map(([name, value]) => {
        const variable = envName(value);
        return `requestBuilder.header(${JSON.stringify(name)}, ${variable ? `System.getenv(${JSON.stringify(variable)})` : JSON.stringify(value)});`;
      })
      .join("\n");
    const javaBody = jsonBody === undefined
      ? "HttpRequest.BodyPublishers.noBody()"
      : `HttpRequest.BodyPublishers.ofString(${JSON.stringify(jsonBody)})`;
    const javaSnippet = `import java.net.URI;\nimport java.net.http.HttpClient;\nimport java.net.http.HttpRequest;\nimport java.net.http.HttpResponse;\n\nvar requestBuilder = HttpRequest.newBuilder(URI.create(${JSON.stringify(url)}));\n${javaHeaders}\nvar request = requestBuilder.method(${JSON.stringify(normalizedMethod)}, ${javaBody}).build();\nvar response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());\nSystem.out.println(response.statusCode() + ": " + response.body());`;

    const snippets = { curl: curlSnippet, javascript: jsSnippet, python: pythonSnippet, php: phpSnippet, java: javaSnippet };
    const missingBodyNote = operation.requestBody && parsedBody === undefined
      ? "\n\nThis operation requires a JSON body. Pass the body argument as valid JSON before using the snippet."
      : "";
    return result(`${snippets[language]}${missingBodyNote}`);
  }
);

const invoiceBodySchema = z.object(invoiceInput).strict().refine(
  (invoice) => !(invoice.due_at && invoice.due_days !== undefined),
  "Provide due_at or due_days, not both."
);

const writeToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

server.registerTool(
  "edpay_create_invoice",
  {
    title: "Create EDPay draft invoice",
    description: "Create a persistent draft invoice in the EDPay environment selected by the caller's existing API key pair packaged in this MCP request's credential (invoices:write scope required). EDPay validates the original pair, account, environment, expiry, and scope. This does not send an invoice email, create a payable link, charge a customer, or mark anything paid. Call only when the user explicitly asks to create an invoice. Supply a stable idempotency_key and reuse it if retrying. The server does not use process-wide customer credentials.",
    inputSchema: {
      idempotency_key: idempotencyKey,
      invoice: invoiceBodySchema,
    },
    annotations: writeToolAnnotations,
  },
  async ({ idempotency_key, invoice }) => {
    if (!getOperation("POST", "/v1/invoices")) {
      return result("The documented POST /v1/invoices operation is missing from the local OpenAPI contract.", true);
    }
    const response = await callInvoiceApi("/v1/invoices", "POST", invoice, idempotency_key, credentials);
    if (!response.ok) return errorResult(response);
    const created = invoiceFromResponse(response);
    if (!created) return result("EDPay accepted the request, but its invoice response did not match the documented response shape. Check the operation with edpay_get_operation before retrying.", true);
    return result(JSON.stringify({
      action: "draft_invoice_created",
      environment: response.environment,
      invoice: summarizeInvoice(created),
      note: "The invoice is a draft. It has not been emailed, finalized, charged, or marked paid.",
    }, null, 2));
  }
);

server.registerTool(
  "edpay_create_payment_link",
  {
    title: "Create an EDPay invoice and payment link",
    description: "Create a draft invoice and finalize it to create an active EDPay hosted checkout link. This requires the documented POST /v1/invoices and POST /v1/invoices/{id}/finalize operations and the invoices:write scope. It does not charge a customer or send an email, but the resulting link can accept payment once shared. Call only when the user explicitly asks to create a payable link. The environment comes from the caller's existing test or live API key pair packaged in this MCP request's credential; EDPay validates the pair and its account environment. It is never a tool argument. Supply a stable idempotency_key and reuse it if retrying. The server does not use process-wide customer credentials.",
    inputSchema: {
      idempotency_key: idempotencyKey,
      invoice: invoiceBodySchema,
    },
    annotations: writeToolAnnotations,
  },
  async ({ idempotency_key, invoice }) => {
    if (!getOperation("POST", "/v1/invoices") || !getOperation("POST", "/v1/invoices/{id}/finalize")) {
      return result("The documented invoice-create/finalize operations are missing from the local OpenAPI contract.", true);
    }
    const createdResponse = await callInvoiceApi("/v1/invoices", "POST", invoice, idempotency_key, credentials);
    if (!createdResponse.ok) return errorResult(createdResponse);
    const created = invoiceFromResponse(createdResponse);
    const invoiceId = created?.id;
    if (!created || typeof invoiceId !== "string" || !/^inv_[A-Za-z0-9_-]{1,120}$/.test(invoiceId)) {
      return result("EDPay accepted invoice creation, but returned no safe invoice ID to finalize. Do not retry with a different idempotency key; inspect the invoice using the configured API tools.", true);
    }

    const finalizedResponse = await callInvoiceApi(
      `/v1/invoices/${encodeURIComponent(invoiceId)}/finalize`,
      "POST",
      undefined,
      undefined,
      credentials
    );
    if (!finalizedResponse.ok) {
      return result(JSON.stringify({
        action: "invoice_created_but_link_not_confirmed",
        environment: createdResponse.environment,
        invoice: summarizeInvoice(created),
        next_step: "The draft may already exist. Retry this tool with the same idempotency_key after resolving the returned error; do not generate a new key for the same request.",
        error: { status: finalizedResponse.status, code: finalizedResponse.code, message: finalizedResponse.message },
      }, null, 2), true);
    }
    const finalized = invoiceFromResponse(finalizedResponse);
    if (!finalized) {
      return result("EDPay accepted invoice finalization, but the response did not match the documented invoice shape. Inspect the invoice before retrying.", true);
    }
    const summary = summarizeInvoice(finalized);
    return result(JSON.stringify({
      action: "invoice_payment_link_created",
      environment: finalizedResponse.environment,
      invoice: summary,
      link_available: Boolean(summary.checkout_url && summary.payment_link_id),
      note: summary.checkout_url
        ? "The active hosted link can accept payment once shared. No charge or customer email was sent by this tool."
        : "The invoice was finalized and the payment link is active, but EDPay did not return a checkout URL. Check the API's PLATFORM_WEB_ORIGIN configuration before sharing the link.",
    }, null, 2));
  }
);

server.tool(
  "edpay_list_integration_guides",
  "List the repository's integration guides and official SDK pages for system-specific context.",
  {},
  async () => {
    const guides = [
      ...["magento", "opencart", "prestashop", "shopify", "whmcs", "woocommerce"].map((name) => ({ type: "plugin", name, path: `/plugins/${name}` })),
      ...["dotnet", "java", "javascript", "php", "python"].map((name) => ({ type: "sdk", name, path: `/sdks/${name}` })),
    ];
    return result(JSON.stringify(guides, null, 2));
  }
);

server.resource("openapi", "edpay://openapi/v1", async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "application/yaml", text: openApiText }],
}));

return server;
}
