## Public Documentation and Sensitive Data

- Treat all unauthenticated routes, MCP responses, README content, examples, container metadata, and generated artifacts as public.
- Never publish real test or production keys, tokens, passwords, webhook secrets, private runtime values, internal hosts, absolute local/server paths, or customer identifiers.
- Public setup responses may link to the customer-facing dashboard and explain credential creation. They must never retrieve, echo, infer, persist, or display credential values.
- Do not publish provider credentials, provider-only settings, account-specific configuration, or internal service topology. Describe only EDPay's customer-facing behavior.
- Before release, scan source and built artifacts for secret-shaped values and private paths; confirm request logs do not contain headers or credential values.
