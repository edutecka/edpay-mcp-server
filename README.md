# EDPay MCP Server

This repository contains the EDPay Streamable HTTP MCP server. It reads the public, versioned API contract bundled with the source and calls EDPay over HTTPS for its limited invoice actions.

## Hosted endpoint

When deployed behind the API ingress, the preferred endpoint is `https://api-pay.edutecka.com/v1/mcp`, with public setup instructions at `https://api-pay.edutecka.com/v1/mcp/setup`. The legacy `/mcp` and `/mcp/setup` paths remain available for compatibility. Setup requires no authentication and never returns or retrieves credential values.

Read-only MCP tools work without customer credentials. For remote MCP writes, create a credential under **Dashboard → Developers → EDPay MCP** and configure its one-time `X-EDPay-MCP-Key` value in the MCP client's secure secret store. The value packages the existing public/private API key pair; the API still validates the same pair, account, environment, expiry, and `invoices:write` scope. Revoking or expiring that pair also disables the MCP credential. Never put credentials in tool arguments, prompts, URLs, browser code, repositories, or logs.

`pk_test_` with `sk_test_` selects Sandbox. `pk_live_` with `sk_live_` selects Production. Mixed pairs are rejected; the EDPay API validates credentials and account environment.

## Run the HTTP service

Build and run the container with the deployment's approved container workflow. It listens on port `23883`; the trusted API ingress maps both public path pairs (`/v1/mcp` and `/v1/mcp/setup`, plus legacy `/mcp` and `/mcp/setup`) to the service's `/mcp` and `/mcp/setup` handlers. The ingress unpacks `X-EDPay-MCP-Key` into the existing API key headers for `/v1/mcp` requests. The application binds only inside its container in non-container local mode; set `EDPAY_MCP_BIND_HOST=0.0.0.0` only when the container network and ingress rules are configured for it.

The deployment must set `EDPAY_MCP_ALLOWED_HOSTS` and `EDPAY_MCP_ALLOWED_ORIGINS` to the exact customer-facing API host and browser origin. The defaults are `api-pay.edutecka.com` and `https://api-pay.edutecka.com`. Do not enable wildcard origins or access logging for credential headers.

## Environment

- `EDPAY_MCP_PORT`: internal HTTP port (default `23883`).
- `EDPAY_MCP_BIND_HOST`: listener address (default `127.0.0.1`).
- `EDPAY_MCP_ALLOWED_HOSTS`: comma-separated allowed Host names.
- `EDPAY_MCP_ALLOWED_ORIGINS`: comma-separated allowed browser Origin values; requests without Origin are allowed for server-side MCP clients.

Customer credentials are never configured in server environment variables. Each HTTP request gets an isolated MCP server instance whose invoice actions use only that request's forwarded API key pair.

## Tools

- `edpay_get_key_setup`: unauthenticated key-creation and secure-storage instructions; never returns key values.
- `edpay_list_operations`: list/filter operations from the versioned OpenAPI contract.
- `edpay_get_operation`: inspect parameters, authentication, request bodies, and responses.
- `edpay_generate_snippet`: generate server-side request examples.
- `edpay_list_integration_guides`: list maintained SDK and plugin guides.
- `edpay_create_invoice`: create a draft invoice only when explicitly requested.
- `edpay_create_payment_link`: create/finalize an invoice into an active hosted payment link only when explicitly requested.
- `edpay://openapi/v1`: expose the bundled OpenAPI document as an MCP resource.

The MCP does not expose arbitrary HTTP calls or provider credentials. A draft invoice does not email or charge anyone. A payment link can accept payment after it is shared, but creating it does not charge a customer or send email.
