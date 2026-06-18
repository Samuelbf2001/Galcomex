import { TipoCliente } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

/**
 * Verifica que el trámite existe y, si el usuario es SOCIO, que el cliente
 * del trámite sea SOCIO_LM (el socio solo accede a sus propios trámites).
 *
 * Retorna:
 *  - null            → trámite no encontrado (404)
 *  - "forbidden"     → SOCIO sin acceso a este trámite (403)
 *  - { id }          → acceso permitido
 */
export async function resolverTramiteConPermiso(
  tramiteId: string,
  rolUsuario: string,
): Promise<null | "forbidden" | { id: string }> {
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: { id: true, cliente: { select: { tipo: true } } },
  });

  if (!tramite) {
    return null;
  }

  if (rolUsuario === "SOCIO" && tramite.cliente.tipo !== TipoCliente.SOCIO_LM) {
    return "forbidden";
  }

  return { id: tramite.id };
}
