import { ImportarExcelWorkspace } from "@/components/importar/importar-excel-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function ImportarExcelPage() {
  await exigirAccesoPagina("/configuracion/importar");

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
