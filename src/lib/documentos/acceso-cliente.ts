/**
 * Regla de autorización para GET /api/clientes/[id]/documentos — repositorio
 * documental agregado por cliente (A2-T3 extendido, ver reunión 2026-07-01).
 *
 * Función PURA (sin BD) que reutiliza el mismo criterio que
 * `resolverTramiteConPermiso` (src/lib/auth/tramite-acceso.ts): un usuario
 * con rol SOCIO solo puede ver información de clientes SOCIO_LM. El resto de
 * roles habilitados para listar documentos (ADMIN, REVISOR, OPERATIVO) no
 * tienen restricción adicional aquí — la pertenencia a la lista de roles
 * permitidos ya la exige `requireRole` en el endpoint.
 */

import { TipoCliente } from "@prisma/client";

export function puedeVerDocumentosDeCliente(
  rolUsuario: string,
  tipoCliente: TipoCliente,
): boolean {
  if (rolUsuario === "SOCIO") {
    return tipoCliente === TipoCliente.SOCIO_LM;
  }

  return true;
}
