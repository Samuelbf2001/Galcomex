import { ImportarExcelWorkspace } from "@/components/importar/importar-excel-workspace";
import { getCurrentSession } from "@/lib/auth/session";

export default async function ImportarExcelPage() {
  const session = await getCurrentSession();
  const esAdmin = session?.user.rol === "ADMIN";

  if (!esAdmin) {
    return (
      <section className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Importar Excel</h1>
        </div>
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No autorizado. Esta sección solo está disponible para administradores.
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Importar Excel</h1>
        <p className="mt-1 text-sm text-slate-600">
          Carga el histórico operativo (GRUPO E PAPIS 2026) y asócialo a un cliente
          existente. Previsualiza el resultado por hoja antes de escribir en la base de
          datos.
        </p>
      </div>
      <ImportarExcelWorkspace />
    </section>
  );
}
