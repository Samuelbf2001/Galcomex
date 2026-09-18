"use client";

import { useState } from "react";

import { ConceptosTab } from "@/components/configuracion/catalogos/conceptos-tab";
import { EventosTab } from "@/components/configuracion/catalogos/eventos-tab";
import { ProductosImpuestosTab } from "@/components/configuracion/catalogos/productos-impuestos-tab";

type TabId = "conceptos" | "eventos" | "productos";

const TABS: { id: TabId; label: string }[] = [
  { id: "conceptos", label: "Conceptos de venta" },
  { id: "eventos", label: "Eventos" },
  { id: "productos", label: "Productos Siigo ↔ impuestos" },
];

/**
 * Configuración → Catálogos: un solo lugar para las listas que hoy viven
 * repartidas entre migraciones, código y memoria de Camila (docs/CATALOGOS.md).
 * Pestañas accesibles (mismo patrón que `tramite-detalle.tsx`): las ya
 * visitadas quedan montadas y ocultas para no perder su estado al cambiar de
 * pestaña.
 */
export function CatalogosWorkspace() {
  const [activeTab, setActiveTab] = useState<TabId>("conceptos");
  const [visitedTabs, setVisitedTabs] = useState<TabId[]>(["conceptos"]);

  function selectTab(id: TabId) {
    setActiveTab(id);
    setVisitedTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  return (
    <div>
      <div className="flex overflow-x-auto border-b border-slate-200" role="tablist" aria-label="Catálogos">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`catalogos-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`catalogos-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex((item) => item.id === tab.id);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % TABS.length
                  : event.key === "ArrowLeft"
                    ? (index - 1 + TABS.length) % TABS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              selectTab(TABS[next].id);
              document.getElementById(`catalogos-tab-${TABS[next].id}`)?.focus();
            }}
            className={`inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-4 text-sm font-medium transition ${
              activeTab === tab.id
                ? "border-slate-950 text-slate-950"
                : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {visitedTabs.includes("conceptos") ? (
          <div
            id="catalogos-panel-conceptos"
            role="tabpanel"
            aria-labelledby="catalogos-tab-conceptos"
            hidden={activeTab !== "conceptos"}
          >
            <ConceptosTab />
          </div>
        ) : null}
        {visitedTabs.includes("eventos") ? (
          <div
            id="catalogos-panel-eventos"
            role="tabpanel"
            aria-labelledby="catalogos-tab-eventos"
            hidden={activeTab !== "eventos"}
          >
            <EventosTab />
          </div>
        ) : null}
        {visitedTabs.includes("productos") ? (
          <div
            id="catalogos-panel-productos"
            role="tabpanel"
            aria-labelledby="catalogos-tab-productos"
            hidden={activeTab !== "productos"}
          >
            <ProductosImpuestosTab />
          </div>
        ) : null}
      </div>
    </div>
  );
}
