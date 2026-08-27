import { prisma } from "@/lib/db/prisma";
import { BeneficiariosConfig } from "@/components/configuracion/beneficiarios-config";
import { MatricesConfig } from "@/components/configuracion/matrices-config";
import { ParametrosConfig } from "@/components/configuracion/parametros-config";
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
  const parametrosRaw = await prisma.parametro.findMany({
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
  const parametros = parametrosRaw.map((p) => ({
    id: p.id,
    clave: p.clave,
    valor: p.valor,
    descripcion: p.descripcion,
  }));

  // BigInt no serializa entre Server Component y Client Component: se
  // convierte costoFijo a string aquí (igual que jsonResponse en las APIs).
  const [matrizRecaudoRaw, matrizPagoRaw] = await Promise.all([
    prisma.matrizRecaudo.findMany({ orderBy: { tipoRecaudo: "asc" } }),
    prisma.matrizPago.findMany({ orderBy: { canalPago: "asc" } }),
  ]);
  const matrizRecaudo = matrizRecaudoRaw.map((m) => ({
    id: m.id,
    tipoRecaudo: m.tipoRecaudo,
    grupo: m.grupo,
    descripcion: m.descripcion,
    costoFijo: m.costoFijo.toString(),
  }));
  const matrizPago = matrizPagoRaw.map((m) => ({
    id: m.id,
    canalPago: m.canalPago,
    descripcion: m.descripcion,
    costoFijo: m.costoFijo.toString(),
  }));

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Configuracion</h1>
        <p className="mt-1 text-sm text-slate-600">
          Parametros financieros y matriz del sistema.
        </p>
      </div>
      <ParametrosConfig parametros={parametros} esAdmin={esAdmin} />
      <MatricesConfig
        matrizRecaudo={matrizRecaudo}
        matrizPago={matrizPago}
        esAdmin={esAdmin}
      />
      <BeneficiariosConfig />
      <SiigoProductos />
      <SiigoParametros />
      {esAdmin ? <UsuariosConfig usuarios={usuarios} /> : null}
    </section>
  );
}
