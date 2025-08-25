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
    console.log(`[tool] getClients called { skip: ${skip}, take: ${take} }`);
    const rows = await prisma.user.findMany({ skip, take });
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

const getProductsSchema = {
  active: z.boolean().optional(),
} as const;

server.registerTool(
  "getProducts",
  {
    description:
      "Devuelve todos los productos (permite filtrar por sectionId, subSectionId y active). Agrega 'formattedPrice' (es-AR) en cada item.",
    inputSchema: getProductsSchema,
  },
  async ({ active }, _extra) => {
    console.log(`[tool] getProducts called { active: ${active ?? "-"} }`);
    const where: any = {};
    if (active !== undefined) where.active = active;
    const products = await prisma.product.findMany({
      include: {
        section: {
          include: {
            subSections: true,
          },
        },
      },
      orderBy: [
        { sectionId: "asc" },
        { order: "asc" },
        { subSectionId: "asc" },
        { subSectionOrder: "asc" },
      ],
      where,
    });

    const nf = new Intl.NumberFormat("es-AR", {
      style: "decimal",
      currency: "ARS",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

    const formatted = products.map((p: any) => ({
      ...p,
      formattedPrice: nf.format(Number(p.price)),
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
    };
  }
);

// Tool: productos por nombre (búsqueda parcial, case-insensitive)
const getProductsByNameSchema = {
  name: z.string().min(1),
  sectionId: z.number().int().min(1).optional(),
  subSectionId: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
} as const;

server.registerTool(
  "getProductsByName",
  {
    description:
      "Busca productos por nombre (coincidencia parcial, case-insensitive). Permite filtrar por sectionId, subSectionId y active. Agrega 'formattedPrice' (es-AR).",
    inputSchema: getProductsByNameSchema,
  },
  async ({ name, sectionId, subSectionId, active }, _extra) => {
    console.log(
      `[tool] getProductsByName called { name: ${name}, sectionId: ${
        sectionId ?? "-"
      }, subSectionId: ${subSectionId ?? "-"}, active: ${active ?? "-"} }`
    );

    const where: any = {
      name: { contains: name, mode: "insensitive" },
    };
    if (sectionId) where.sectionId = sectionId;
    if (subSectionId) where.subSectionId = subSectionId;
    if (active !== undefined) where.active = active;

    const products = await prisma.product.findMany({
      include: {
        section: {
          include: { subSections: true },
        },
      },
      orderBy: [
        { sectionId: "asc" },
        { order: "asc" },
        { subSectionId: "asc" },
        { subSectionOrder: "asc" },
      ],
      where,
    });

    const nf = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    const formatted = products.map((p: any) => ({
      ...p,
      formattedPrice: nf.format(Number(p.price)),
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
    };
  }
);

// Tool: contar productos (con filtros opcionales)
const getProductsCountSchema = {
  sectionId: z.number().int().min(1).optional(),
  subSectionId: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
} as const;

server.registerTool(
  "getProductsCount",
  {
    description:
      "Devuelve el conteo total de productos (permite filtrar por sectionId, subSectionId y active)",
    inputSchema: getProductsCountSchema,
  },
  async ({ sectionId, subSectionId, active }, _extra) => {
    console.log(
      `[tool] getProductsCount called { sectionId: ${
        sectionId ?? "-"
      }, subSectionId: ${subSectionId ?? "-"}, active: ${active ?? "-"} }`
    );
    const where: any = {};
    if (sectionId) where.sectionId = sectionId;
    if (subSectionId) where.subSectionId = subSectionId;
    if (active !== undefined) where.active = active;
    const count = await prisma.product.count({ where });
    return { content: [{ type: "text", text: JSON.stringify({ count }) }] };
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
    console.log(
      `[tool] createProduct called { name: ${name}, price: ${price}, sectionId: ${sectionId}, subSectionId: ${
        subSectionId ?? "-"
      } }`
    );
    const product = await prisma.product.create({
      data: { name, price, sectionId, subSectionId },
    });
    return {
      content: [{ type: "text", text: JSON.stringify(product, null, 2) }],
    };
  }
);

// Tool: actualizar descripción de un producto
const updateProductSchema = {
  id: z.number().int().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
  price: z.coerce.number().positive().optional(),
  sectionId: z.number().int().min(1).optional(),
  subSectionId: z.number().int().min(1).optional(),
  order: z.number().int().min(0).optional(),
} as const;

server.registerTool(
  "updateProduct",
  {
    description:
      "Actualiza campos de un producto por id o nombre (name/description/active/price/sectionId/subSectionId/order)",
    inputSchema: updateProductSchema,
  },
  async (
    { id, name, description, active, price, sectionId, subSectionId, order },
    _extra
  ) => {
    console.log(
      `[tool] updateProduct called { id: ${id ?? "-"}, name: ${
        name ?? "-"
      } }, active: ${active ?? "-"}, price: ${price ?? "-"}, sectionId: ${
        sectionId ?? "-"
      }, subSectionId: ${subSectionId ?? "-"}, order: ${order ?? "-"}`
    );
    // Debe indicar cómo identificar el producto
    if (!id && !name) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Debe enviar id o name" }),
          },
        ],
      };
    }
    // Debe enviar al menos un campo actualizable
    if (
      !id &&
      !name &&
      !active &&
      !price &&
      !sectionId &&
      !subSectionId &&
      order === undefined &&
      !description
    ) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error:
                "Debe enviar algún campo para actualizar: name, description, active, price, sectionId, subSectionId u order",
            }),
          },
        ],
      };
    }
    const where: any = id ? { id } : { name };
    const updated = await prisma.product.update({
      where,
      data: {
        name,
        description,
        active,
        price,
        sectionId,
        subSectionId,
        order,
      },
    });
    return {
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
    };
  }
);

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

  // Contadores por método HTTP
  const counters: Record<string, number> = {
    GET: 0,
    POST: 0,
    PUT: 0,
    DELETE: 0,
    PATCH: 0,
    OTHER: 0,
  };
  app.use((req, _res, next) => {
    const m = (req.method || "OTHER").toUpperCase();
    if (counters[m] === undefined) counters.OTHER++;
    else counters[m]++;
    console.log(`[http] ${req.method} ${req.path}`);
    next();
  });

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

  // Al cerrar, imprime resumen
  const printSummary = () => {
    console.log(
      `[http] summary -> GET: ${counters.GET}, POST: ${counters.POST}, PUT: ${counters.PUT}, PATCH: ${counters.PATCH}, DELETE: ${counters.DELETE}, OTHER: ${counters.OTHER}`
    );
  };
  process.on("SIGINT", () => {
    printSummary();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    printSummary();
    process.exit(0);
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
