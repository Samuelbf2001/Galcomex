import { describe, expect, it } from "vitest";

import { etiquetaLineaServicio } from "@/lib/cuenta-corriente/etiquetas-linea";

describe("etiquetaLineaServicio", () => {
  it("la línea del tipo Exportación (30-sep-2026) sale legible, como en el filtro de cartera", () => {
    expect(etiquetaLineaServicio("EXPORTACION")).toBe("Exportación");
  });

  it("las de siempre no cambian y un código desconocido se muestra tal cual", () => {
    expect(etiquetaLineaServicio("TRAMITE")).toBe("Trámites");
    expect(etiquetaLineaServicio("OTROS")).toBe("Otros servicios");
    expect(etiquetaLineaServicio("NUEVA_LINEA")).toBe("NUEVA_LINEA");
  });
});
