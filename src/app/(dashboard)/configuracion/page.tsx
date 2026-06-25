import { prisma } from "@/lib/db/prisma";
import { BeneficiariosConfig } from "@/components/configuracion/beneficiarios-config";
import { SiigoParametros } from "@/components/configuracion/siigo-parametros";
import { SiigoProductos } from "@/components/configuracion/siigo-productos";
import { UsuariosConfig } from "@/components/configuracion/usuarios-config";
import { getCurrentSession } from "@/lib/auth/session";
import { listarUsuarios } from "@/lib/usuarios/service";

export default async function ConfiguracionPage() {
  const session = await getCurrentSession();
  const esAdmin = session?.user.rol === "ADMIN";
  const usuarios = esAdmin ? await listarUsuarios() : [];
  // Solo parámetros NO-Siigo: los Siigo se editan desde SiigoParametros.
  const parametros = await prisma.parametro.findMany({
    where: { clave: { notIn: [
      "SIIGO_TIPO_COMPROBANTE_ID",
      "SIIGO_VENDEDOR_ID",
      "SIIGO_PRODUCTO_COMISION_ID",
      "SIIGO_FORMA_PAGO_DEFAULT_ID",
      "SIIGO_PRODUCTO_4X1000_ID",
      "SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID",
    ] } },
    orderBy: { clave: "asc" },
  });

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Configuracion</h1>
        <p className="mt-1 text-sm text-slate-600">
          Parametros financieros y matriz del sistema.
        </p>
      </div>
      <div className="overflow-hidden border border-slate-200 bg-white">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="border-b border-slate-200 px-4 py-3">Clave</th>
              <th className="border-b border-slate-200 px-4 py-3">Valor</th>
              <th className="border-b border-slate-200 px-4 py-3">Descripcion</th>
            </tr>
          </thead>
          <tbody>
            {parametros.map((parametro) => (
              <tr key={parametro.id} className="border-b border-slate-100">
                <td className="px-4 py-3 font-mono text-xs">{parametro.clave}</td>
                <td className="px-4 py-3">{parametro.valor}</td>
                <td className="px-4 py-3 text-slate-600">
                  {parametro.descripcion}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BeneficiariosConfig />
      <SiigoProductos />
      <SiigoParametros />
      {esAdmin ? <UsuariosConfig usuarios={usuarios} /> : null}
    </section>
  );
}
