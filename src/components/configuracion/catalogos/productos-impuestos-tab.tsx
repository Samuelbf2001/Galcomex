"use client";

import { SiigoProductos } from "@/components/configuracion/siigo-productos";
import { ModuleState } from "@/components/layout/module-state";
import { usePermiso } from "@/lib/auth/rol-context";

/**
 * Pestaña "Productos Siigo ↔ impuestos": enlaza la pantalla de Catálogos
 * Siigo que ya existe en Configuración (`SiigoProductos`) en vez de duplicar
 * su lógica de sincronización y asignación de impuestos. El origen
 * (Siigo/Manual) y el aviso de "guardar a mano congela el producto" viven en
 * esa pantalla (`ProductosModal`), que los muestra por cada impuesto asignado.
 *
 * `GET /api/configuracion/siigo/productos` es ADMIN-only: a REVISOR no se le
 * dispara la petición (evita un 403 inútil), se le explica por qué no ve nada.
 */
export function ProductosImpuestosTab() {
  const esAdmin = usePermiso(["ADMIN"]);

  if (!esAdmin) {
    return (
      <ModuleState
        type="empty"
        title="Solo disponible para administradores"
        detail="Los productos Siigo y sus impuestos se editan desde el rol ADMIN. Como REVISOR puedes ver conceptos y eventos en las otras pestañas."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Productos Siigo ↔ impuestos</h2>
        <p className="text-xs text-slate-500">
          El sincronizador trae los impuestos de cada producto automáticamente. Si asignas
          impuestos a mano desde &ldquo;Ver catálogo&rdquo;, ese producto queda congelado frente
          al siguiente sync: sus impuestos ya no se pisan solos.
        </p>
      </div>
      <SiigoProductos />
    </div>
  );
}
