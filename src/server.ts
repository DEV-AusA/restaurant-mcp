import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Prisma } from "@prisma/client";
import express from "express";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import cors from "cors";

dotenv.config();
const prisma = new PrismaClient();

const server = new Server(
  {
    name: "restaurant-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

type ToolHandler = (args: any) => Promise<any>;

const tools: Record<
  string,
  {
    description: string;
    inputSchema: any;
    handler: ToolHandler;
  }
> = {};

type CreateProductArgs = {
  name: string;
  price: number | string;
  description?: string;
  sectionId?: number;
  sectionName?: string;
  subSectionId?: number;
  subSectionName?: string;
};

//Tools del MCP
tools["getUsers"] = {
  description: `
    Obtiene una lista paginada de los usuarios en el sistema del restaurante.

    Usar cuando:
    - El usuario pide ver todos los usuarios del sistema
    - Necesita listado administrativo

    Parámetros:
    - skip: cantidad de registros a omitir (paginación)
    - take: cantidad máxima de registros a devolver

    Devuelve:
    - Lista de usuarios con sus campos almacenados en la base de datos
            `.trim(),
  inputSchema: {
    type: "object",
    properties: {
      skip: { type: "number" },
      take: { type: "number" },
    },
  },
  handler: async (args) => {
    const skip = typeof args?.skip === "number" ? args.skip : 0;
    const take = typeof args?.take === "number" ? args.take : 50;

    const rows = await prisma.user.findMany({ skip, take });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(rows, null, 2),
        },
      ],
    };
  },
};

tools["getProducts"] = {
  description:
    "Devuelve todos los productos del restaurante. Permite filtrar por estado activo (active). Incluye información de sección y subsección y agrega formattedPrice en es-AR.",

  inputSchema: {
    type: "object",
    properties: {
      active: {
        type: "boolean",
        description:
          "Si es true devuelve solo productos activos; si es false solo inactivos",
      },
    },
    additionalProperties: false,
  },

  handler: async (args) => {
    console.log("ARGS RECEIVED:", args);

    const active =
      args && typeof args.active === "boolean" ? args.active : undefined;

    const where: any = {};

    if (active !== undefined) {
      where.active = active;
    }

    try {
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
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });

      const formatted = products.map((p: any) => ({
        ...p,
        formattedPrice: nf.format(Number(p.price)),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formatted, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Error in getProducts:", error);
      throw error;
    }
  },
};

tools["createProduct"] = {
  description: `
  Crea un nuevo producto en el restaurante.
  
  Requiere obligatoriamente:
  - name (string)
  - price (number o string convertible a número)
  - sectionId o sectionName
  
  Opcional:
  - description (string): descripción del producto
  - subSectionId o subSectionName
  
  Notas:
  - Si la sección tiene subsecciones, debe enviarse una subsección válida.
  - El agente debe preguntar al usuario si desea agregar una descripción antes de llamar a esta tool.
  - El producto se inserta al final del orden correspondiente (order o subSectionOrder).
  `.trim(),
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      price: { type: "number" },
      description: {
        type: "string",
        description: "Descripción opcional del producto",
      },
      sectionId: { type: "number" },
      sectionName: { type: "string" },
      subSectionId: { type: "number" },
      subSectionName: { type: "string" },
    },
    required: ["name", "price"],
    additionalProperties: false,
  },
  handler: async (args: CreateProductArgs) => {
    const {
      name,
      price,
      description,
      sectionId,
      sectionName,
      subSectionId,
      subSectionName,
    } = args;

    console.log(
      `[tool] createProduct called { name: ${name}, price: ${price}, sectionId: ${
        sectionId ?? "-"
      }, sectionName: ${sectionName ?? "-"}, subSectionId: ${
        subSectionId ?? "-"
      }, subSectionName: ${subSectionName ?? "-"} }`,
    );

    if (!sectionId && !sectionName) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Debe enviar 'sectionId' o 'sectionName'",
            }),
          },
        ],
      };
    }

    try {
      let section: any | null = null;

      if (sectionId) {
        section = await prisma.section.findUnique({
          where: { id: sectionId },
          include: { subSections: true },
        });
        if (!section) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Sección no encontrada: id=${sectionId}`,
                }),
              },
            ],
          };
        }
      } else if (sectionName) {
        section = await prisma.section.findFirst({
          where: { name: { equals: sectionName, mode: "insensitive" } },
          include: { subSections: true },
        });
        if (!section) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Sección no encontrada: ${sectionName}`,
                }),
              },
            ],
          };
        }
      }

      const targetSectionId = section.id as number;

      if (section.subSection === true && !subSectionId && !subSectionName) {
        const subs = (section.subSections || []).map((s: any) => ({
          id: s.id,
          name: s.name,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "La sección tiene subsecciones. Debe indicar 'subSectionId' o 'subSectionName'.",
                subSections: subs,
                message:
                  "Seleccione una subsección y vuelva a llamar a createProduct con subSectionId o subSectionName.",
              }),
            },
          ],
        };
      }

      let targetSubSectionId: number | undefined = subSectionId;
      if (!targetSubSectionId && subSectionName) {
        const sub = section.subSections.find(
          (s: any) => s.name.toLowerCase() === subSectionName.toLowerCase(),
        );
        if (!sub) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Subsección no encontrada en la sección '${section.name}': ${subSectionName}`,
                  subSections: (section.subSections || []).map((s: any) => ({
                    id: s.id,
                    name: s.name,
                  })),
                }),
              },
            ],
          };
        }
        targetSubSectionId = sub.id;
      }

      let data: any = {
        name,
        price,
        description: description ?? null,
        sectionId: targetSectionId,
      };

      if (section.subSection === true && targetSubSectionId) {
        const lastInSub = await prisma.product.findFirst({
          where: {
            sectionId: targetSectionId,
            subSectionId: targetSubSectionId,
          },
          orderBy: { subSectionOrder: "desc" },
          select: { subSectionOrder: true },
        });
        const nextSubOrder = (lastInSub?.subSectionOrder ?? 0) + 1;
        data.subSectionId = targetSubSectionId;
        data.subSectionOrder = nextSubOrder;
      } else {
        const lastInSection = await prisma.product.findFirst({
          where: { sectionId: targetSectionId, subSectionId: null },
          orderBy: { order: "desc" },
          select: { order: true },
        });
        const nextOrder = (lastInSection?.order ?? 0) + 1;
        data.subSectionId = null;
        data.order = nextOrder;
      }

      const product = await prisma.product.create({ data });

      return {
        content: [{ type: "text", text: JSON.stringify(product, null, 2) }],
      };
    } catch (error) {
      console.error("[tool] createProduct error:", error);
      throw error;
    }
  },
};

type DeleteProductArgs = {
  id?: number;
  name?: string;
};

tools["deleteProduct"] = {
  description: `
Elimina un producto del restaurante y ajusta los índices de orden de los productos afectados.

Requiere al menos uno de:
- id (number): id del producto a eliminar
- name (string): nombre exacto del producto a eliminar

Notas:
- Si se envía 'name', se asume que es único en el sistema.
- Tras eliminar, decrementa en 1 solo los productos con orden mayor al eliminado, en su sección o subsección correspondiente.
- La eliminación y el ajuste de orden se realizan en una transacción atómica.
- Retorna el id eliminado.
  `.trim(),
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "ID del producto a eliminar" },
      name: {
        type: "string",
        description: "Nombre exacto del producto a eliminar",
      },
    },
    additionalProperties: false,
  },
  handler: async (args: DeleteProductArgs) => {
    const { id, name } = args;

    console.log(
      `[tool] deleteProduct called { id: ${id ?? "-"}, name: ${name ?? "-"} }`,
    );

    if (!id && !name) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Debe enviar 'id' o 'name'" },
              null,
              2,
            ),
          },
        ],
      };
    }

    try {
      const where: any = id ? { id } : { name };

      const existing = await prisma.product.findUnique({
        where,
      });

      if (!existing) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: "Producto no encontrado" },
                null,
                2,
              ),
            },
          ],
        };
      }

      await prisma.$transaction(async (tx) => {
        await tx.product.delete({ where: { id: existing.id } });

        if (existing.subSectionId) {
          // Producto en subsección: shift de subSectionOrder
          const toShift = await tx.product.findMany({
            where: {
              sectionId: existing.sectionId,
              subSectionId: existing.subSectionId,
              subSectionOrder: { gt: existing.subSectionOrder ?? 0 },
            },
            orderBy: { subSectionOrder: "asc" },
          });
          for (const p of toShift) {
            await tx.product.update({
              where: { id: p.id },
              data: { subSectionOrder: p.subSectionOrder - 1 },
            });
          }
        } else {
          // Producto top-level: shift de order
          const toShift = await tx.product.findMany({
            where: {
              sectionId: existing.sectionId,
              subSectionId: null,
              order: { gt: existing.order ?? 0 },
            },
            orderBy: { order: "asc" },
          });
          for (const p of toShift) {
            await tx.product.update({
              where: { id: p.id },
              data: { order: p.order - 1 },
            });
          }
        }
      });

      console.log(`[tool] deleteProduct -> deletedId: ${existing.id}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ deletedId: existing.id }, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("[tool] deleteProduct error:", error);
      throw error;
    }
  },
};

//handler de las tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.entries(tools).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = tools[name];

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool.handler(args);
});

type UpdateProductArgs = {
  id?: number;
  name?: string;
  newName?: string;
  newPrice?: number;
  newDescription?: string;
  newSectionId?: number;
  newSectionName?: string;
  newSubSectionId?: number;
  newSubSectionName?: string;
};

tools["updateProduct"] = {
  description: `
Actualiza un producto existente del restaurante.

Para identificar el producto, requiere al menos uno de:
- id (number): id del producto
- name (string): nombre exacto del producto actual

Campos actualizables (todos opcionales, enviar solo los que se quieren modificar):
- newName (string): nuevo nombre del producto
- newPrice (number): nuevo precio del producto
- newDescription (string): nueva descripción del producto
- newSectionId o newSectionName: nueva sección destino
- newSubSectionId o newSubSectionName: nueva subsección destino

Notas:
- Si solo se modifican name, price o description, el orden y posición del producto no cambian.
- Si se cambia la sección o subsección, el producto se inserta al final del orden en el destino.
- Si la sección destino tiene subsecciones, se debe indicar también newSubSectionId o newSubSectionName.
- El agente debe preguntar al usuario qué campos desea modificar antes de llamar a esta tool.
  `.trim(),
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "ID del producto a actualizar" },
      name: {
        type: "string",
        description: "Nombre actual del producto para identificarlo",
      },
      newName: { type: "string", description: "Nuevo nombre del producto" },
      newPrice: { type: "number", description: "Nuevo precio del producto" },
      newDescription: {
        type: "string",
        description: "Nueva descripción del producto",
      },
      newSectionId: {
        type: "number",
        description: "ID de la nueva sección destino",
      },
      newSectionName: {
        type: "string",
        description: "Nombre de la nueva sección destino",
      },
      newSubSectionId: {
        type: "number",
        description: "ID de la nueva subsección destino",
      },
      newSubSectionName: {
        type: "string",
        description: "Nombre de la nueva subsección destino",
      },
    },
    additionalProperties: false,
  },
  handler: async (args: UpdateProductArgs) => {
    const {
      id,
      name,
      newName,
      newPrice,
      newDescription,
      newSectionId,
      newSectionName,
      newSubSectionId,
      newSubSectionName,
    } = args;

    console.log(`[tool] updateProduct called`, args);

    if (!id && !name) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Debe enviar 'id' o 'name' para identificar el producto",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    try {
      const where: any = id ? { id } : { name };

      const existing = await prisma.product.findUnique({
        where,
        include: { section: { include: { subSections: true } } },
      });

      if (!existing) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: "Producto no encontrado" },
                null,
                2,
              ),
            },
          ],
        };
      }

      const wantsToChangeSection = newSectionId || newSectionName;

      // -------------------------------------------------------
      // CASO 1: Solo actualización de campos simples (sin cambio de sección)
      // -------------------------------------------------------
      if (!wantsToChangeSection) {
        const updated = await prisma.product.update({
          where: { id: existing.id },
          data: {
            ...(newName !== undefined && { name: newName }),
            ...(newPrice !== undefined && { price: newPrice }),
            ...(newDescription !== undefined && {
              description: newDescription,
            }),
            updatedAt: new Date(),
          },
        });

        return {
          content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
        };
      }

      // -------------------------------------------------------
      // CASO 2: Cambio de sección (y opcionalmente subsección)
      // -------------------------------------------------------
      let destSection: any = null;

      if (newSectionId) {
        destSection = await prisma.section.findUnique({
          where: { id: newSectionId },
          include: { subSections: true },
        });
        if (!destSection) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: `Sección no encontrada: id=${newSectionId}` },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      } else if (newSectionName) {
        destSection = await prisma.section.findFirst({
          where: { name: { equals: newSectionName, mode: "insensitive" } },
          include: { subSections: true },
        });
        if (!destSection) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: `Sección no encontrada: ${newSectionName}` },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      // Si la sección destino tiene subsecciones y no se indicó ninguna, devolver lista
      if (
        destSection.subSection === true &&
        !newSubSectionId &&
        !newSubSectionName
      ) {
        const subs = (destSection.subSections || []).map((s: any) => ({
          id: s.id,
          name: s.name,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "La sección destino tiene subsecciones. Debe indicar 'newSubSectionId' o 'newSubSectionName'.",
                subSections: subs,
                message:
                  "Seleccione una subsección y vuelva a llamar a updateProduct.",
              }),
            },
          ],
        };
      }

      // Resolver newSubSectionId si vino por nombre
      let targetSubSectionId: number | undefined = newSubSectionId;
      if (!targetSubSectionId && newSubSectionName) {
        const sub = destSection.subSections.find(
          (s: any) => s.name.toLowerCase() === newSubSectionName.toLowerCase(),
        );
        if (!sub) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Subsección no encontrada en la sección '${destSection.name}': ${newSubSectionName}`,
                  subSections: (destSection.subSections || []).map(
                    (s: any) => ({
                      id: s.id,
                      name: s.name,
                    }),
                  ),
                }),
              },
            ],
          };
        }
        targetSubSectionId = sub.id;
      }

      const updated = await prisma.$transaction(async (tx) => {
        // 1) Shift en sección/subsección origen: decrementar los que quedan atrás
        if (existing.subSectionId) {
          const toShift = await tx.product.findMany({
            where: {
              sectionId: existing.sectionId,
              subSectionId: existing.subSectionId,
              subSectionOrder: { gt: existing.subSectionOrder ?? 0 },
            },
            orderBy: { subSectionOrder: "asc" },
          });
          for (const p of toShift) {
            await tx.product.update({
              where: { id: p.id },
              data: { subSectionOrder: p.subSectionOrder - 1 },
            });
          }
        } else {
          const toShift = await tx.product.findMany({
            where: {
              sectionId: existing.sectionId,
              subSectionId: null,
              order: { gt: existing.order ?? 0 },
            },
            orderBy: { order: "asc" },
          });
          for (const p of toShift) {
            await tx.product.update({
              where: { id: p.id },
              data: { order: p.order - 1 },
            });
          }
        }

        // 2) Calcular posición al final en el destino
        let destOrder = 0;
        let destSubSectionOrder = 0;

        if (destSection.subSection === true && targetSubSectionId) {
          const last = await tx.product.findFirst({
            where: {
              sectionId: destSection.id,
              subSectionId: targetSubSectionId,
            },
            orderBy: { subSectionOrder: "desc" },
            select: { subSectionOrder: true },
          });
          destSubSectionOrder = (last?.subSectionOrder ?? 0) + 1;
        } else {
          const last = await tx.product.findFirst({
            where: { sectionId: destSection.id, subSectionId: null },
            orderBy: { order: "desc" },
            select: { order: true },
          });
          destOrder = (last?.order ?? 0) + 1;
        }

        // 3) Actualizar el producto con nueva posición y campos modificados
        return tx.product.update({
          where: { id: existing.id },
          data: {
            ...(newName !== undefined && { name: newName }),
            ...(newPrice !== undefined && { price: newPrice }),
            ...(newDescription !== undefined && {
              description: newDescription,
            }),
            sectionId: destSection.id,
            subSectionId: targetSubSectionId ?? null,
            order: destOrder,
            subSectionOrder: destSubSectionOrder,
            updatedAt: new Date(),
          },
        });
      });

      return {
        content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
      };
    } catch (error) {
      console.error("[tool] updateProduct error:", error);
      throw error;
    }
  },
};

/** 2) START: STDI Opción (local) **/
export async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("MCP conectado por STDIO (dev/local)");
}

/** 3) START: Streamable HTTP (para exponer por HTTPS) **/
export async function startHttp(port = 4000) {
  const app = express();

  app.use(
    cors({
      origin: "*",
      exposedHeaders: ["mcp-session-id"],
      allowedHeaders: ["Content-Type", "mcp-session-id"],
    }),
  );

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

  app.post("/", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else {
      const newSessionId = randomUUID();

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableDnsRebindingProtection: true,
      });

      transports[newSessionId] = transport;

      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  // Health check endpoint
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, uptime: process.uptime() });
  });

  app.listen(port, () => {
    console.log(`MCP Streamable HTTP listening on http://localhost:${port}/`);
  });

  // Al cerrar, imprime resumen
  const printSummary = () => {
    console.log(
      `[http] summary -> GET: ${counters.GET}, POST: ${counters.POST}, PUT: ${counters.PUT}, PATCH: ${counters.PATCH}, DELETE: ${counters.DELETE}, OTHER: ${counters.OTHER}`,
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
