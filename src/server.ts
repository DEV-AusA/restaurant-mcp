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
- subSectionId o subSectionName

Notas:
- Si la sección tiene subsecciones, debe enviarse una subsección válida.
- El producto se inserta al final del orden correspondiente (order o subSectionOrder).
`.trim(),

  inputSchema: {
    type: "object",
    required: ["name", "price"],
    additionalProperties: false,
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description: "Nombre del producto",
      },
      price: {
        type: ["number", "string"],
        description:
          "Precio del producto. Puede enviarse como número o string convertible.",
      },
      sectionId: {
        type: "number",
        description: "ID de la sección destino",
      },
      sectionName: {
        type: "string",
        description: "Nombre de la sección (case-insensitive)",
      },
      subSectionId: {
        type: "number",
        description: "ID de la subsección",
      },
      subSectionName: {
        type: "string",
        description: "Nombre de la subsección (case-insensitive)",
      },
    },
  },

  handler: async (args: CreateProductArgs) => {
    console.log("ARGS RECEIVED (createProduct):", args);

    try {
      //validacion obligatoria name
      if (!args.name || typeof args.name !== "string") {
        throw new Error("Parameter 'name' is required and must be a string.");
      }

      //validacion obligatoria price
      if (args.price === undefined) {
        throw new Error("Parameter 'price' is required.");
      }

      let parsedPrice: number;

      if (typeof args.price === "string") {
        const cleaned = args.price.replace(/[^\d.-]/g, "");
        parsedPrice = Number(cleaned);
      } else {
        parsedPrice = args.price;
      }

      if (Number.isNaN(parsedPrice) || parsedPrice <= 0) {
        throw new Error("Parameter 'price' must be a positive number.");
      }

      //validación seccion
      if (!args.sectionId && !args.sectionName) {
        throw new Error(
          "Either 'sectionId' or 'sectionName' must be provided.",
        );
      }

      let section: Prisma.SectionGetPayload<{
        include: { subSections: true };
      }> | null = null;

      if (typeof args.sectionId === "number") {
        section = await prisma.section.findUnique({
          where: { id: args.sectionId },
          include: { subSections: true },
        });
      } else if (typeof args.sectionName === "string") {
        section = await prisma.section.findFirst({
          where: {
            name: {
              equals: args.sectionName,
              mode: "insensitive",
            },
          },
          include: { subSections: true },
        });
      }

      if (!section) {
        throw new Error("Section not found.");
      }

      const targetSectionId = section.id;

      //validacion subseccion si aplica
      let targetSubSectionId: number | undefined = args.subSectionId;

      if (section.subSection === true) {
        if (!args.subSectionId && !args.subSectionName) {
          throw new Error(
            "This section requires a subSectionId or subSectionName.",
          );
        }

        if (!targetSubSectionId && args.subSectionName) {
          const sub = section.subSections.find(
            (s) => s.name.toLowerCase() === args.subSectionName!.toLowerCase(),
          );

          if (!sub) {
            throw new Error("Subsection not found.");
          }

          targetSubSectionId = sub.id;
        }
      }

      const data: Prisma.ProductCreateInput = {
        name: args.name,
        price: parsedPrice,
        section: {
          connect: { id: targetSectionId },
        },
      };

      // 🔹 Ordenamiento dinámico
      if (section.subSection === true && targetSubSectionId) {
        const last = await prisma.product.findFirst({
          where: {
            sectionId: targetSectionId,
            subSectionId: targetSubSectionId,
          },
          orderBy: { subSectionOrder: "desc" },
          select: { subSectionOrder: true },
        });

        data.subSection = {
          connect: { id: targetSubSectionId },
        };

        data.subSectionOrder = (last?.subSectionOrder ?? 0) + 1;
      } else {
        const last = await prisma.product.findFirst({
          where: {
            sectionId: targetSectionId,
            subSectionId: null,
          },
          orderBy: { order: "desc" },
          select: { order: true },
        });

        data.order = (last?.order ?? 0) + 1;
      }

      const product = await prisma.product.create({ data });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(product, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Error in createProduct:", error);
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

// // Tool: contar productos (con filtros opcionales)
// const getProductsCountSchema = {
//   sectionId: z.number().int().min(1).optional(),
//   subSectionId: z.number().int().min(1).optional(),
//   active: z.boolean().optional(),
// } as const;

// server.registerTool(
//   "getProductsCount",
//   {
//     description:
//       "Devuelve el conteo total de productos (permite filtrar por sectionId, subSectionId y active)",
//     inputSchema: getProductsCountSchema,
//   },
//   async ({ sectionId, subSectionId, active }, _extra) => {
//     console.log(
//       `[tool] getProductsCount called { sectionId: ${
//         sectionId ?? "-"
//       }, subSectionId: ${subSectionId ?? "-"}, active: ${active ?? "-"} }`,
//     );
//     const where: any = {};
//     if (sectionId) where.sectionId = sectionId;
//     if (subSectionId) where.subSectionId = subSectionId;
//     if (active !== undefined) where.active = active;
//     const count = await prisma.product.count({ where });
//     return { content: [{ type: "text", text: JSON.stringify({ count }) }] };
//   },
// );

// // Tool: actualizar descripción de un producto
// const updateProductSchema = {
//   id: z.number().int().min(1).optional(),
//   name: z.string().min(1).optional(),
//   description: z.string().optional(),
//   active: z.boolean().optional(),
//   price: z.coerce.number().positive().optional(),
//   sectionId: z.number().int().min(1).optional(),
//   sectionName: z.string().min(1).optional(),
//   subSectionId: z.number().int().min(1).optional(),
//   subSectionName: z.string().min(1).optional(),
//   subSectionOrder: z.number().int().min(1).optional(),
//   order: z.number().int().min(0).optional(),
// } as const;

// server.registerTool(
//   "updateProduct",
//   {
//     description:
//       "Actualiza campos de un producto por id o nombre (name/description/active/price/sectionId/sectionName/subSectionId/subSectionName/subSectionOrder/order). Si se mueve a una sección con subsecciones y no se indica subsección, devuelve la lista para elegir. Si se indica subSectionOrder, reordena el producto dentro de su subsección.",
//     inputSchema: updateProductSchema,
//   },
//   async (
//     {
//       id,
//       name,
//       description,
//       active,
//       price,
//       sectionId,
//       sectionName,
//       subSectionId,
//       subSectionName,
//       subSectionOrder,
//       order,
//     },
//     _extra,
//   ) => {
//     console.log(
//       `[tool] updateProduct called { id: ${id ?? "-"}, name: ${
//         name ?? "-"
//       } }, active: ${active ?? "-"}, price: ${price ?? "-"}, sectionId: ${
//         sectionId ?? "-"
//       }, sectionName: ${sectionName ?? "-"}, subSectionId: ${
//         subSectionId ?? "-"
//       }, subSectionName: ${subSectionName ?? "-"}, subSectionOrder: ${
//         subSectionOrder ?? "-"
//       }, order: ${order ?? "-"}`,
//     );
//     // Debe indicar cómo identificar el producto
//     if (!id && !name) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify({ error: "Debe enviar id o name" }),
//           },
//         ],
//       };
//     }
//     // Debe enviar al menos un campo actualizable
//     if (
//       !active &&
//       !price &&
//       !sectionId &&
//       !sectionName &&
//       !subSectionId &&
//       !subSectionName &&
//       subSectionOrder === undefined &&
//       order === undefined &&
//       !description &&
//       !name
//     ) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify({
//               error:
//                 "Debe enviar algún campo para actualizar: name, description, active, price, sectionId/sectionName, subSectionId/subSectionName, subSectionOrder u order",
//             }),
//           },
//         ],
//       };
//     }
//     const where: any = id ? { id } : { name };
//     const existing = await prisma.product.findUnique({
//       where,
//       include: {
//         section: { include: { subSections: true } },
//         subSection: true,
//       },
//     });
//     if (!existing) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify({ error: "Producto no encontrado" }),
//           },
//         ],
//       };
//     }

//     // Guardar origen para compactar luego si se mueve de subsección
//     const prevSectionId = existing.sectionId;
//     const prevSubSectionId = existing.subSectionId;

//     // Resolver sección destino si se desea mover (por id o nombre). Si no se indica, usar la actual
//     let targetSection = null as any;
//     if (sectionId || sectionName) {
//       if (sectionId) {
//         targetSection = await prisma.section.findUnique({
//           where: { id: sectionId },
//           include: { subSections: true },
//         });
//       } else if (sectionName) {
//         targetSection = await prisma.section.findFirst({
//           where: { name: { equals: sectionName, mode: "insensitive" } },
//           include: { subSections: true },
//         });
//       }
//       if (!targetSection) {
//         return {
//           content: [
//             {
//               type: "text",
//               text: JSON.stringify({
//                 error: `Sección destino no encontrada: ${
//                   sectionId ?? sectionName
//                 }`,
//               }),
//             },
//           ],
//         };
//       }
//     } else {
//       targetSection = await prisma.section.findUnique({
//         where: { id: existing.sectionId },
//         include: { subSections: true },
//       });
//     }

//     const targetSectionIdFinal = targetSection.id as number;

//     // Si la sección destino tiene subsecciones y no se indicó subSection destino, preguntar
//     if (
//       targetSection.subSection === true &&
//       !subSectionId &&
//       !subSectionName &&
//       // además, o bien estamos moviendo de sección o el producto actual no tiene subsección válida
//       (sectionId || sectionName || !existing.subSectionId)
//     ) {
//       const subs = (targetSection.subSections || []).map((s: any) => ({
//         id: s.id,
//         name: s.name,
//       }));
//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify({
//               error:
//                 "La sección destino tiene subsecciones. Indique 'subSectionId' o 'subSectionName' para completar el movimiento.",
//               subSections: subs,
//               message:
//                 "Seleccione una subsección y vuelva a llamar a updateProduct con subSectionId o subSectionName.",
//             }),
//           },
//         ],
//       };
//     }

//     // Resolver subSection destino si viene por nombre
//     let targetSubId: number | null | undefined =
//       subSectionId ?? existing.subSectionId ?? null;
//     if (subSectionName) {
//       const sub = (targetSection.subSections || []).find(
//         (s: any) => s.name.toLowerCase() === subSectionName.toLowerCase(),
//       );
//       if (!sub) {
//         return {
//           content: [
//             {
//               type: "text",
//               text: JSON.stringify({
//                 error: `Subsección destino no encontrada en la sección '${targetSection.name}': ${subSectionName}`,
//                 subSections: (targetSection.subSections || []).map(
//                   (s: any) => ({ id: s.id, name: s.name }),
//                 ),
//               }),
//             },
//           ],
//         };
//       }
//       targetSubId = sub.id;
//     }

//     // Si se indicó subSectionOrder y la sección destino maneja subsecciones, reordenar en la subsección destino
//     if (
//       subSectionOrder !== undefined &&
//       targetSection.subSection === true &&
//       targetSubId
//     ) {
//       // Obtener productos de la subsección destino en orden
//       const items = await prisma.product.findMany({
//         where: { sectionId: targetSectionIdFinal, subSectionId: targetSubId },
//         orderBy: { subSectionOrder: "asc" },
//         select: { id: true, subSectionOrder: true },
//       });

//       // Normalizar posición objetivo
//       const maxPos = Math.max(items.length, 1);
//       const targetPos = Math.max(1, Math.min(subSectionOrder, maxPos));

//       // Identificar si el producto ya está en esta subsección
//       const isSameSub =
//         existing.sectionId === targetSectionIdFinal &&
//         existing.subSectionId === targetSubId;

//       const currentOrder = isSameSub
//         ? (existing.subSectionOrder ?? null)
//         : null;

//       if (isSameSub && currentOrder === targetPos) {
//         // Nada que hacer, solo actualizar campos simples más abajo
//       } else {
//         // Ajustar órdenes de los demás elementos para dejar libre targetPos
//         if (isSameSub && currentOrder) {
//           if (currentOrder < targetPos) {
//             // Mover hacia abajo: los que estaban entre (currentOrder, targetPos] suben una posición (-1)
//             for (const it of items) {
//               if (
//                 it.id !== id &&
//                 it.subSectionOrder &&
//                 it.subSectionOrder > currentOrder &&
//                 it.subSectionOrder <= targetPos
//               ) {
//                 await prisma.product.update({
//                   where: { id: it.id },
//                   data: { subSectionOrder: (it.subSectionOrder ?? 0) - 1 },
//                 });
//               }
//             }
//           } else {
//             // Mover hacia arriba: los que estaban entre [targetPos, currentOrder) bajan una posición (+1)
//             for (const it of items) {
//               if (
//                 it.id !== id &&
//                 it.subSectionOrder &&
//                 it.subSectionOrder >= targetPos &&
//                 it.subSectionOrder < currentOrder
//               ) {
//                 await prisma.product.update({
//                   where: { id: it.id },
//                   data: { subSectionOrder: (it.subSectionOrder ?? 0) + 1 },
//                 });
//               }
//             }
//           }
//         } else {
//           // Viene de otra subsección u otra sección: desplazar hacia abajo a los elementos desde targetPos en adelante
//           for (const it of items) {
//             if (it.subSectionOrder && it.subSectionOrder >= targetPos) {
//               await prisma.product.update({
//                 where: { id: it.id },
//                 data: { subSectionOrder: (it.subSectionOrder ?? 0) + 1 },
//               });
//             }
//           }
//         }

//         // Asegurar asignación a sección/subsección destino y setear el nuevo orden
//         await prisma.product.update({
//           where,
//           data: {
//             sectionId: targetSectionIdFinal,
//             subSectionId: targetSubId,
//             subSectionOrder: targetPos,
//             order: 0,
//           },
//         });
//         // Refrescar existing para que el resto de campos se apliquen sobre el estado nuevo
//         Object.assign(existing, {
//           sectionId: targetSectionIdFinal,
//           subSectionId: targetSubId,
//           subSectionOrder: targetPos,
//         });
//       }
//     }

//     // Preparar datos base (campos simples)
//     const data: any = {
//       // campos editables directos si se enviaron
//       ...(name !== undefined ? { name } : {}),
//       ...(description !== undefined ? { description } : {}),
//       ...(active !== undefined ? { active } : {}),
//       ...(price !== undefined ? { price } : {}),
//     };

//     // Determinar si hay movimiento entre secciones/subsecciones
//     const movingSection = targetSectionIdFinal !== existing.sectionId;
//     const movingSub = (targetSubId ?? null) !== (existing.subSectionId ?? null);

//     if (
//       movingSection ||
//       movingSub ||
//       sectionId ||
//       sectionName ||
//       subSectionId ||
//       subSectionName
//     ) {
//       // Si ya reordenamos por subSectionOrder arriba, no recalcular el final
//       if (
//         targetSection.subSection === true &&
//         targetSubId &&
//         subSectionOrder !== undefined
//       ) {
//         data.sectionId = targetSectionIdFinal;
//         data.subSectionId = targetSubId;
//         data.order = 0;
//         // mantener subSectionOrder tal como quedó
//       } else if (targetSection.subSection === true && targetSubId) {
//         // mover/colocar en subsección
//         const lastInSub = await prisma.product.findFirst({
//           where: { sectionId: targetSectionIdFinal, subSectionId: targetSubId },
//           orderBy: { subSectionOrder: "desc" },
//           select: { subSectionOrder: true },
//         });
//         const nextSubOrder = (lastInSub?.subSectionOrder ?? 0) + 1;
//         data.sectionId = targetSectionIdFinal;
//         data.subSectionId = targetSubId;
//         data.subSectionOrder = nextSubOrder;
//         data.order = 0; // no aplica en subsección
//       } else {
//         // mover/colocar en top-level de sección
//         const lastInSection = await prisma.product.findFirst({
//           where: { sectionId: targetSectionIdFinal, subSectionId: null },
//           orderBy: { order: "desc" },
//           select: { order: true },
//         });
//         const nextOrder = (lastInSection?.order ?? 0) + 1;
//         data.sectionId = targetSectionIdFinal;
//         data.subSectionId = null;
//         data.subSectionOrder = 0;
//         data.order = nextOrder;
//       }
//     } else {
//       // No hay movimiento, pero si envió 'order', aplicarlo tal cual (reordenamiento manual)
//       if (order !== undefined) data.order = order;
//       if (subSectionId !== undefined) data.subSectionId = subSectionId;
//     }

//     const updated = await prisma.product.update({ where, data });

//     // Si el producto se movió fuera de su subsección de origen, compactar la subsección anterior
//     const movedOutOfPrevSub =
//       (prevSubSectionId ?? null) !== (targetSubId ?? null) ||
//       prevSectionId !== targetSectionIdFinal;
//     if (prevSubSectionId && movedOutOfPrevSub) {
//       const remaining = await prisma.product.findMany({
//         where: { sectionId: prevSectionId, subSectionId: prevSubSectionId },
//         orderBy: { subSectionOrder: "asc" },
//         select: { id: true },
//       });
//       let pos = 1;
//       for (const it of remaining) {
//         await prisma.product.update({
//           where: { id: it.id },
//           data: { subSectionOrder: pos++ },
//         });
//       }
//     }

//     return {
//       content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
//     };
//   },
// );

// // Tool: eliminar producto con recompacción de órdenes
// const deleteProductSchema = {
//   id: z.number().int().min(1).optional(),
//   name: z.string().min(1).optional(),
// } as const;

// server.registerTool(
//   "deleteProduct",
//   {
//     description:
//       "Elimina un producto por id o nombre y reordena compactando los índices en su sección o subsección según corresponda.",
//     inputSchema: deleteProductSchema,
//   },
//   async ({ id, name }, _extra) => {
//     console.log(
//       `[tool] deleteProduct called { id: ${id ?? "-"}, name: ${name ?? "-"} }`,
//     );

//     if (!id && !name) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify(
//               { error: "Debe enviar 'id' o 'name'" },
//               null,
//               2,
//             ),
//           },
//         ],
//       };
//     }

//     // Nota: esto asume 'name' único, igual que updateProduct
//     const where: any = id ? { id } : { name };
//     const existing = await prisma.product.findUnique({
//       where,
//       select: {
//         id: true,
//         sectionId: true,
//         subSectionId: true,
//       },
//     });

//     if (!existing) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify({ error: "Producto no encontrado" }, null, 2),
//           },
//         ],
//       };
//     }

//     // Hacer todo dentro de una transacción para no dejar órdenes inconsistentes
//     const result = await prisma.$transaction(async (tx) => {
//       // 1) Eliminar
//       const deleted = await tx.product.delete({ where: { id: existing.id } });

//       // 2) Recompactar según contenedor
//       let compacted = 0;
//       if (existing.subSectionId) {
//         // Dentro de una subsección: reordenar subSectionOrder desde 1
//         const items = await tx.product.findMany({
//           where: {
//             sectionId: existing.sectionId,
//             subSectionId: existing.subSectionId,
//           },
//           orderBy: { subSectionOrder: "asc" },
//           select: { id: true },
//         });
//         let pos = 1;
//         for (const it of items) {
//           await tx.product.update({
//             where: { id: it.id },
//             data: { subSectionOrder: pos++ },
//           });
//           compacted++;
//         }
//       } else {
//         // Top-level de sección: reordenar order desde 1 (manteniendo subSectionId en null)
//         const items = await tx.product.findMany({
//           where: { sectionId: existing.sectionId, subSectionId: null },
//           orderBy: { order: "asc" },
//           select: { id: true },
//         });
//         let pos = 1;
//         for (const it of items) {
//           await tx.product.update({
//             where: { id: it.id },
//             data: { order: pos++, subSectionOrder: 0 },
//           });
//           compacted++;
//         }
//       }

//       return { deletedId: deleted.id, compacted };
//     });

//     console.log(
//       `[tool] deleteProduct -> deletedId: ${result.deletedId}, compacted: ${result.compacted}`,
//     );

//     return {
//       content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
//     };
//   },
// );

// // Tool: productos por nombre de sección (case-insensitive)
// const getProductsBySectionNameSchema = {
//   sectionName: z.string().min(1),
//   subSectionName: z.string().min(1).optional(),
//   active: z.boolean().optional(),
// } as const;

// server.registerTool(
//   "getProductsBySectionName",
//   {
//     description:
//       "Devuelve los productos de una sección por nombre (case-insensitive). Si la sección tiene subsecciones, agrupa por subsección y respeta el orden; también permite filtrar por una 'subSectionName' específica. Agrega 'formattedPrice' (es-AR).",
//     inputSchema: getProductsBySectionNameSchema,
//   },
//   async ({ sectionName, subSectionName, active }, _extra) => {
//     console.log(
//       `[tool] getProductsBySectionName called { sectionName: ${sectionName}, subSectionName: ${
//         subSectionName ?? "-"
//       }, active: ${active ?? "-"} }`,
//     );

//     // 1) Resolver sección por nombre (case-insensitive)
//     const section = await prisma.section.findFirst({
//       where: { name: { equals: sectionName, mode: "insensitive" } },
//       include: { subSections: true },
//     });

//     if (!section) {
//       const available = await prisma.section.findMany({
//         select: { id: true, name: true, subSection: true, order: true },
//         orderBy: { order: "asc" },
//       });
//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify(
//               {
//                 error: `Sección no encontrada: ${sectionName}`,
//                 sections: available,
//               },
//               null,
//               2,
//             ),
//           },
//         ],
//       };
//     }

//     // Formateador de precio (es-AR)
//     const nf = new Intl.NumberFormat("es-AR", {
//       style: "currency",
//       currency: "ARS",
//       minimumFractionDigits: 2,
//       maximumFractionDigits: 2,
//     });

//     // 2) Si NO tiene subsecciones
//     if (section.subSection !== true) {
//       if (subSectionName) {
//         return {
//           content: [
//             {
//               type: "text",
//               text: JSON.stringify(
//                 {
//                   error: `La sección '${section.name}' no tiene subsecciones. No puede usar 'subSectionName'.`,
//                   section: {
//                     id: section.id,
//                     name: section.name,
//                     subSection: false,
//                   },
//                 },
//                 null,
//                 2,
//               ),
//             },
//           ],
//         };
//       }
//       const where: any = { sectionId: section.id, subSectionId: null };
//       if (active !== undefined) where.active = active;

//       const products = await prisma.product.findMany({
//         where,
//         orderBy: [{ order: "asc" }],
//       });

//       const formatted = products.map((p: any) => ({
//         ...p,
//         formattedPrice: nf.format(Number(p.price)),
//       }));

//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify(
//               {
//                 section: {
//                   id: section.id,
//                   name: section.name,
//                   subSection: false,
//                 },
//                 products: formatted,
//               },
//               null,
//               2,
//             ),
//           },
//         ],
//       };
//     }

//     // 3) Tiene subsecciones: si viene subSectionName -> solo esa; si no, agrupar todas
//     // Ordenar subsecciones por su campo 'order'
//     const subSections = [...(section.subSections || [])].sort(
//       (a: any, b: any) => (a.order ?? 0) - (b.order ?? 0),
//     );

//     const result: any = {
//       section: { id: section.id, name: section.name, subSection: true },
//       subSections: [] as any[],
//     };

//     // Si se especificó una subsección por nombre, devolver solo esa
//     if (subSectionName) {
//       const sub = subSections.find(
//         (s: any) => s.name.toLowerCase() === subSectionName.toLowerCase(),
//       );
//       if (!sub) {
//         return {
//           content: [
//             {
//               type: "text",
//               text: JSON.stringify(
//                 {
//                   error: `Subsección no encontrada en la sección '${section.name}': ${subSectionName}`,
//                   subSections: subSections.map((s: any) => ({
//                     id: s.id,
//                     name: s.name,
//                     order: s.order,
//                   })),
//                 },
//                 null,
//                 2,
//               ),
//             },
//           ],
//         };
//       }

//       const where: any = { sectionId: section.id, subSectionId: sub.id };
//       if (active !== undefined) where.active = active;

//       const items = await prisma.product.findMany({
//         where,
//         orderBy: [{ subSectionOrder: "asc" }],
//       });

//       const formatted = items.map((p: any) => ({
//         ...p,
//         formattedPrice: nf.format(Number(p.price)),
//       }));

//       result.subSections.push({
//         id: sub.id,
//         name: sub.name,
//         order: sub.order,
//         products: formatted,
//       });

//       return {
//         content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
//       };
//     }

//     // Si no se solicitó una subsección específica, listar todas
//     for (const sub of subSections) {
//       const where: any = { sectionId: section.id, subSectionId: sub.id };
//       if (active !== undefined) where.active = active;

//       const items = await prisma.product.findMany({
//         where,
//         orderBy: [{ subSectionOrder: "asc" }],
//       });

//       const formatted = items.map((p: any) => ({
//         ...p,
//         formattedPrice: nf.format(Number(p.price)),
//       }));

//       result.subSections.push({
//         id: sub.id,
//         name: sub.name,
//         order: sub.order,
//         products: formatted,
//       });
//     }

//     return {
//       content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
//     };
//   },
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
