import { PrismaClient } from "@prisma/client";

import { exigirUnidadCentavos } from "@/lib/dinero/guardia-bd";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * Guardia de unidad (fase centavos, A.4): antes de la PRIMERA consulta del
 * proceso se verifica que `Parametro DINERO_UNIDAD_BD = "CENTAVOS"`; si no,
 * toda consulta lanza `UnidadDineroBdError` (status 503) en vez de leer o
 * escribir montos en la unidad equivocada. El éxito se recuerda (una sola
 * lectura por proceso).
 *
 * En las pruebas (`NODE_ENV=test`) la guardia está apagada salvo
 * `DINERO_GUARDIA_EN_PRUEBAS=1`: las BD de prueba se limpian entre archivos y
 * la guardia tiene sus propias pruebas unitarias.
 */
function guardiaActiva(): boolean {
  return process.env.NODE_ENV !== "test" || process.env.DINERO_GUARDIA_EN_PRUEBAS === "1";
}

function crearCliente(): PrismaClient {
  const base = new PrismaClient();
  const leerParametro = async (clave: string) =>
    (await base.parametro.findUnique({ where: { clave }, select: { valor: true } }))?.valor ?? null;

  // La extensión de consultas no cambia los tipos del cliente: se conserva el
  // tipo `PrismaClient` para todo el código existente (`$transaction`, `tx`).
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        if (guardiaActiva()) await exigirUnidadCentavos(leerParametro);
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? crearCliente();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
