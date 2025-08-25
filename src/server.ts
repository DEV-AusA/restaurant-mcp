// src/mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();
const prisma = new PrismaClient();

/** 1) crea el servidor MCP y registra herramientas (tools) **/
const server = new McpServer({
  name: "restaurant-mcp",
  version: "0.1.0",
});

// Tool: listar clientes (paginada)
// SDK espera ZodRawShape, no JSON Schema
const getClientsSchema = {
  skip: z.number().int().min(0).optional(),
  take: z.number().int().min(1).optional(),
} as const;

server.registerTool(
  "getClients",
  {
    description: "Devuelve clientes (skip,take)",
    inputSchema: getClientsSchema,
  },
  async ({ skip = 0, take = 50 }, _extra) => {
    const rows = await prisma.user.findMany({ skip, take });
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// Tool: productos por sección/subsección
// También como ZodRawShape
const getProductsBySectionSchema = {
  sectionId: z.number().int().min(1).optional(),
  subSectionId: z.number().int().min(1).optional(),
} as const;

server.registerTool(
  "getProductsBySection",
  {
    description: "Filtra por sectionId o subSectionId",
    inputSchema: getProductsBySectionSchema,
  },
  async ({ sectionId, subSectionId }, _extra) => {
    const where: any = {};
    if (sectionId) where.sectionId = sectionId;
    if (subSectionId) where.subSectionId = subSectionId;
    const rows = await prisma.product.findMany({ where });
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// esquema de entrada (ZodRawShape)
const createProductSchema = {
  name: z.string().min(1),
  // Prisma define price como Decimal(10,2). Acepta número y/o string que se pueda convertir.
  price: z.coerce.number().positive(), // coerciona "123.45" -> 123.45
  sectionId: z.number().int().min(1),
  subSectionId: z.number().int().min(1).optional(),
} as const;

server.registerTool(
  "createProduct",
  {
    description: "Crea un producto",
    inputSchema: createProductSchema,
  },
  async ({ name, price, sectionId, subSectionId }, _extra) => {
    const product = await prisma.product.create({
      data: { name, price, sectionId, subSectionId },
    });
    return {
      content: [{ type: "text", text: JSON.stringify(product, null, 2) }],
    };
  }
);

// Tool: crear pedido
// server.registerTool(
//   "createOrder",
//   {
//     description: "Crea un pedido simple (clienteId, total)",
//     inputSchema: {
//       type: "object",
//       properties: {
//         clienteId: { type: "number" },
//         total: { type: "number" },
//       },
//       additionalProperties: false,
//     },
//   },
//   async ({ clienteId, total }, _extra) => {
//     const pedido = await prisma.pedido.create({
//       data: { clienteId, total, estado: "pendiente" },
//     });
//     return { content: [{ type: "text", text: JSON.stringify(pedido, null, 2) }] };
//   }
// );

/** 2) START: STDI Opción (local) **/
export async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("MCP conectado por STDIO (dev/local)");
}

/** 3) START: Streamable HTTP (para exponer por HTTPS) **/
export async function startHttp(port = 4000) {
  const app = express();
  app.use(express.json());

  // map sessionId => transport
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.all("/mcp", async (req, res) => {
    // Si es inicialización (cliente iniciando sesión), creamos transport y conectamos
    const init = isInitializeRequest(req.body);
    if (init) {
      const sessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        enableDnsRebindingProtection: true,
      });

      transports[sessionId] = transport;
      await server.connect(transport);

      // el transport generalmente maneja la respuesta de init por su cuenta:
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Si no es init, el request debe traer header o query con sessionId
    const sid = (req.headers["mcp-session-id"] || req.query.sessionId) as
      | string
      | undefined;
    if (!sid || !transports[sid]) {
      return res.status(400).send("Invalid or missing sessionId");
    }
    const transport = transports[sid];
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => {
    console.log(
      `MCP Streamable HTTP listening on http://localhost:${port}/mcp`
    );
  });
}

// Bootstrap: inicia automáticamente según variable de entorno
const mode = process.env.MCP_MODE ?? "http";
if (mode === "stdio") {
  startStdio().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  const port = Number(process.env.PORT) || 4000;
  startHttp(port).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
