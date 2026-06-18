import { prisma } from "@/lib/db/prisma";

export default async function ConfiguracionPage() {
  const parametros = await prisma.parametro.findMany({
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
    </section>
  );
}
