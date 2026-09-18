import { CatalogosWorkspace } from "@/components/configuracion/catalogos/catalogos-workspace";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";

export default async function CatalogosPage() {
  await exigirAccesoPagina("/configuracion/catalogos");

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Catálogos</h1>
        <p className="mt-1 text-sm text-slate-600">
          Conceptos de venta, eventos y productos Siigo con sus impuestos: un solo lugar para lo
          que antes vivía repartido entre migraciones, código y memoria.
        </p>
      </div>
      <CatalogosWorkspace />
    </section>
  );
}
