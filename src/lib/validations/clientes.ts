import { TipoCliente } from "@prisma/client";
import { z } from "zod";

export const tipoClienteQuerySchema = z
  .enum(["propio", "socio_lm", "PROPIO", "SOCIO_LM"])
  .optional()
  .transform((tipo) => {
    if (!tipo) {
      return undefined;
    }

    return tipo.toUpperCase() as TipoCliente;
  });

export const tarifaClienteSchema = z.object({
  anio: z.number().int().min(2020).max(2100),
  tipo: z.enum(["por_contenedor", "fijo", "porcentaje_cif"]),
  valor: z.coerce.bigint().refine((valor) => valor >= 0n, {
    message: "La tarifa no puede ser negativa",
  }),
});

/**
 * Forma común de los campos de un cliente, SIN `.default()`. Es la base de
 * `clienteUpdateSchema` (F1): en Zod 4, `.partial()` sobre un esquema con
 * `.default()` sigue rellenando con el default las claves ausentes del body
 * (en vez de dejarlas `undefined`), así que un PATCH parcial como
 * `{ contactoNombre, contactoEmail, contactoTel }` (el pop-up de Contacto,
 * `contacto-editor.tsx`) terminaba reescribiendo también
 * tipo/activo/esCliente/esProveedor/manejaAnticipo con sus valores por
 * defecto. Los defaults de negocio solo aplican al crear, en
 * `clientePayloadSchema`.
 */
const clienteBaseSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  nit: z.string().trim().min(1, "El NIT es obligatorio"),
  tipo: z.nativeEnum(TipoCliente),
  contactoNombre: z.string().trim().min(1).optional().nullable(),
  contactoEmail: z.string().trim().email().optional().nullable(),
  contactoTel: z.string().trim().min(1).optional().nullable(),
  /** Ciudad de la empresa; sale en la cotización (PDF del tarifario). */
  ciudad: z
    .string()
    .trim()
    .max(80, "Máximo 80 caracteres")
    .optional()
    .nullable()
    // "" -> null (campo vacío = sin ciudad); `undefined` (campo ausente en un
    // PATCH parcial) se deja intacto para que Prisma no toque la columna.
    .transform((valor) => (valor === "" ? null : valor)),
  manejaAnticipo: z.boolean(),
  activo: z.boolean(),
  /**
   * Roles simultáneos de la contraparte (M5): una misma empresa puede ser
   * cliente y proveedor a la vez (Ascinter, Coldex, Eltrans).
   */
  esCliente: z.boolean(),
  esProveedor: z.boolean(),
  /** Grupo económico (Polired / Polired Zona Franca bajo una casa). */
  grupoEmpresaId: z.string().min(1).optional().nullable(),
  tarifas: z.array(tarifaClienteSchema),
});

export const clientePayloadSchema = clienteBaseSchema.extend({
  tipo: z.nativeEnum(TipoCliente).default(TipoCliente.PROPIO),
  manejaAnticipo: z.boolean().default(true),
  activo: z.boolean().default(true),
  esCliente: z.boolean().default(true),
  esProveedor: z.boolean().default(false),
  tarifas: z.array(tarifaClienteSchema).default([]),
});

/**
 * PATCH/PUT parcial: cada clave queda opcional y SIN default, así que solo
 * las claves realmente presentes en el body llegan al resultado (ver
 * `src/app/api/clientes/[id]/route.ts`).
 */
export const clienteUpdateSchema = clienteBaseSchema.partial();

/**
 * `?fields=options` en GET /api/clientes → listado liviano para selects
 * (`{ id, nombre, nit, tipo, activo }`, sin tarifas). Sin el parámetro, el
 * listado completo con tarifas se mantiene igual.
 */
export const clienteFieldsQuerySchema = z.enum(["options"]).optional();
