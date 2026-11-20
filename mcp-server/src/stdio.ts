import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./index.js";

const server = createMcpServer({
  publicKey: process.env.EDPAY_PUBLIC_KEY,
  privateKey: process.env.EDPAY_PRIVATE_KEY,
});

await server.connect(new StdioServerTransport());
