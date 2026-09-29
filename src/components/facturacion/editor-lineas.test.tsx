import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorLineas, mismoMonto } from "./editor-lineas";
import { crearLineaManual, actualizarLinea, type BorradorRow, type LineaRevisionRow } from "./facturacion-api";
import { fetchSiigoProductos, type SiigoProductoRow } from "@/components/configuracion/siigo-productos-api";

vi.mock("@/components/facturas-proveedor/facturas-proveedor-api", () => ({ fetchFacturasProveedor: vi.fn().mockResolvedValue([]) }));
vi.mock("@/components/configuracion/siigo-productos-api", () => ({ fetchSiigoProductos: vi.fn().mockResolvedValue({ productos: [] }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }), describirError: (error: Error) => error.message }));
vi.mock("./facturacion-api", async (original) => ({
  ...await original<typeof import("./facturacion-api")>(),
  crearLineaManual: vi.fn(),
  actualizarLinea: vi.fn(),
}));

// Dinero = pesos texto con 2 decimales, como lo emite la API tras la fase
// centavos (`textoDeCentavos`), leído en pantalla con `centavosDeTextoApi`.
const borrador = {
  id: "draft-1", tramiteId: "tramite-1", comentariosCabecera: [], comision: "400000.00",
  ivaComision: "76000.00", retenciones: "0.00", totalFactura: "10000.00", lineasRevision: [
    { id: "line-1", orden: 1, concepto: "Transporte", valor: "10000.00", seccion: "TERCEROS", tipoFija: null, facturasVinculadas: [], nitTercero: null },
  ],
} as unknown as BorradorRow;

let container: HTMLDivElement;
let root: Root;

async function cambiar(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<EditorLineas borrador={borrador} tramiteId="tramite-1" puedeEditar onBorradorActualizado={vi.fn()} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Editor de líneas: recuperación de errores", () => {
  it("conserva los datos de una línea nueva cuando falla el guardado y permite volver a enviarla", async () => {
    vi.mocked(crearLineaManual).mockRejectedValueOnce(new Error("Sin conexión")).mockResolvedValueOnce(borrador);
    const concepto = container.querySelector<HTMLInputElement>('input[placeholder="Ej. Impuestos aduanas importación"]')!;
    const valor = container.querySelector<HTMLInputElement>('input[placeholder="0"]')!;
    await cambiar(concepto, "Flete nuevo");
    await cambiar(valor, "50000");
    const agregar = [...container.querySelectorAll("button")].find((button) => button.textContent === "Agregar línea")!;
    await act(async () => agregar.click());
    expect(concepto.value).toBe("Flete nuevo");
    // Mientras el campo conserva el texto tal como se escribió (sin blur, A.8
    // deviación #3 de P1) no lleva puntos de miles.
    expect(valor.value).toBe("50000");
    expect(container.textContent).toContain("No se guardó el cambio");
    await act(async () => agregar.click());
    expect(crearLineaManual).toHaveBeenCalledTimes(2);
    expect(concepto.value).toBe("");
  });

  it("guarda el concepto al salir del campo sin abrir un formulario adicional", async () => {
    vi.mocked(actualizarLinea).mockResolvedValue(borrador);
    const concepto = container.querySelector<HTMLInputElement>('input[aria-label="Concepto de la línea 1"]')!;
    await cambiar(concepto, "Transporte actualizado");
    await act(async () => concepto.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(actualizarLinea).toHaveBeenCalledWith("draft-1", "line-1", { concepto: "Transporte actualizado" });
    expect(container.textContent).toContain("Cambio guardado");
  });

  it("no envía importes vacíos ni cero", async () => {
    const valor = container.querySelector<HTMLInputElement>('input[aria-label="Valor en COP de la línea 1"]')!;
    await cambiar(valor, "0");
    await act(async () => valor.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(actualizarLinea).not.toHaveBeenCalled();
    expect(valor.value).toBe("0");
    expect(valor.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("mayor que cero");
  });

  it("mantiene el cambio fallido al recibir otro borrador y ofrece reintento por campo", async () => {
    vi.mocked(actualizarLinea).mockRejectedValueOnce(new Error("Sin conexión")).mockResolvedValueOnce(borrador);
    const concepto = container.querySelector<HTMLInputElement>('input[aria-label="Concepto de la línea 1"]')!;
    await cambiar(concepto, "Conservar este concepto");
    await act(async () => concepto.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    const actualizado = { ...borrador, lineasRevision: borrador.lineasRevision.map((linea) => ({ ...linea, concepto: "Otro dato del servidor" })) };
    await act(async () => root.render(<EditorLineas borrador={actualizado} tramiteId="tramite-1" puedeEditar onBorradorActualizado={vi.fn()} />));
    expect(concepto.value).toBe("Conservar este concepto");
    expect(concepto.getAttribute("aria-invalid")).toBe("true");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reintentar este cambio")!;
    await act(async () => retry.click());
    expect(actualizarLinea).toHaveBeenLastCalledWith("draft-1", "line-1", { concepto: "Conservar este concepto" });
    expect(concepto.getAttribute("aria-invalid")).toBe("false");
  });

  it("un doble blur no envía dos veces el mismo cambio", async () => {
    let resolver!: (row: BorradorRow) => void;
    vi.mocked(actualizarLinea).mockImplementationOnce(() => new Promise((resolve) => { resolver = resolve; }));
    const concepto = container.querySelector<HTMLInputElement>('input[aria-label="Concepto de la línea 1"]')!;
    await cambiar(concepto, "Un único cambio");
    await act(async () => {
      concepto.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      concepto.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(actualizarLinea).toHaveBeenCalledTimes(1);
    await act(async () => resolver(borrador));
  });
});

describe("Editor de líneas: valor sin cambios o mal escrito (hallazgos 1 y 11)", () => {
  const valor = () => container.querySelector<HTMLInputElement>('input[aria-label="Valor en COP de la línea 1"]')!;
  const salir = async () => act(async () => valor().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

  it("entrar y salir sin escribir no guarda (\"10000\" del campo = \"10000.00\" de la API)", async () => {
    await act(async () => valor().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    await salir();
    await cambiar(valor(), "10000");
    await salir();
    await cambiar(valor(), "10.000,00");
    await salir();
    expect(actualizarLinea).not.toHaveBeenCalled();
  });

  it("un monto mal escrito no se guarda y muestra el motivo del campo", async () => {
    await cambiar(valor(), "10,000");
    await salir();
    expect(actualizarLinea).not.toHaveBeenCalled();
    expect(container.textContent).toContain("¿Quisiste decir 10.000 o 10,00?");
    expect(valor().getAttribute("aria-invalid")).toBe("true");
  });

  it("un cambio real sí se guarda, canónico", async () => {
    vi.mocked(actualizarLinea).mockResolvedValue(borrador);
    await cambiar(valor(), "10.000,5");
    await salir();
    expect(actualizarLinea).toHaveBeenCalledWith("draft-1", "line-1", { valor: "10000.50" });
  });

  it("mismoMonto compara en centavos", () => {
    expect(mismoMonto("486075", "486075.00")).toBe(true);
    expect(mismoMonto("486075.5", "486075.50")).toBe(true);
    expect(mismoMonto("486075", "486075.01")).toBe(false);
    expect(mismoMonto("", "0.00")).toBe(false);
  });
});

describe("Editor de líneas: vista previa del IVA en formato COMISION (pendiente de integración)", () => {
  it("desglosa la línea IVA_COMISION que ya está en el subtotal; no suma 19 % fijo encima", async () => {
    const conComision = {
      ...borrador,
      formatoFactura: "COMISION",
      lineasRevision: [
        ...borrador.lineasRevision,
        { id: "c", orden: 2, concepto: "COMISION", valor: "400000.00", seccion: "OPERACIONAL", tipoFija: "COMISION", facturasVinculadas: [], nitTercero: null },
        { id: "i", orden: 3, concepto: "IVA COMISION", valor: "76000.00", seccion: "OPERACIONAL", tipoFija: "IVA_COMISION", facturasVinculadas: [], nitTercero: null },
      ],
    } as unknown as BorradorRow;
    await act(async () => root.render(<EditorLineas borrador={conComision} tramiteId="tramite-1" puedeEditar onBorradorActualizado={vi.fn()} />));
    const texto = container.textContent ?? "";
    expect(texto).not.toContain("IVA (19%)");
    expect(texto).not.toContain("Total con IVA");
    expect(texto).toContain("De ellos, IVA");
    // Subtotal OPERACIONAL 476.000 = 400.000 sin IVA + 76.000 de IVA (antes: 476.000 + 90.440 = 566.440).
    expect(texto).not.toContain("566.440");
    const plano = texto.replace(/\s/g, " ");
    expect(plano).toContain("De ellos, IVA$ 76.000");
    expect(plano).toContain("Sin IVA$ 400.000");
  });
});

// Dinero como lo emite la API tras la fase centavos: pesos texto con 2 decimales.
describe("Producto SIIGO en líneas existentes", () => {
  const productoTransporte: SiigoProductoRow = {
    id: "p1",
    codigo: "TR01",
    nombre: "TRANSPORTE",
    tipo: "Product",
    activo: true,
    grupoContableId: 1,
    grupoContableNombre: "Ingresos",
    clasificacionIva: "Excluded",
    sincronizadoEn: "2026-01-01T00:00:00.000Z",
    impuestos: [],
  };

  function lineaBase(overrides: Partial<LineaRevisionRow>): LineaRevisionRow {
    return {
      id: "line-1",
      borradorId: "draft-1",
      concepto: "Transporte",
      numSoporte: null,
      valor: "10000.00",
      orden: 1,
      observacion: null,
      origen: "MANUAL",
      seccion: "TERCEROS",
      tipoFija: null,
      facturasVinculadas: [],
      nitTercero: null,
      siigoProductoId: null,
      siigoProductoCodigo: null,
      siigoProductoNombre: null,
      siigoClasificacionIva: null,
      aplicaIva: false,
      ...overrides,
    };
  }

  function borradorCon(
    lineasRevision: LineaRevisionRow[],
    formatoFactura: string = "COMISION",
    // "APROBADO" reproduce el comportamiento previo a la revisión (único
    // estado sin editar que existía en los tests antes de que el aviso
    // distinguiera por `estado`).
    estado: string = "APROBADO",
  ): BorradorRow {
    return {
      id: "draft-1",
      tramiteId: "tramite-1",
      comentariosCabecera: [],
      comision: "400000.00",
      ivaComision: "76000.00",
      retenciones: "0.00",
      totalFactura: "10000.00",
      formatoFactura,
      estado,
      lineasRevision,
    } as unknown as BorradorRow;
  }

  // Remonta desde cero (en vez de reutilizar el `root` del beforeEach) porque
  // el catálogo de productos se carga una sola vez al montar: hay que fijar
  // el mock ANTES de montar para que estos tests lo vean.
  async function remontar(
    row: BorradorRow,
    opts: {
      puedeEditar?: boolean;
      productos?: SiigoProductoRow[];
      /**
       * Simula un catálogo que rechaza (403 por rol, red caída, etc.) en vez
       * de resolver vacío. Con esto `catalogos.errores` no queda vacío, a
       * diferencia de `productos: []` (catálogo cargado y vacío de verdad).
       */
      catalogoRechazado?: boolean;
    } = {},
  ) {
    const { puedeEditar = true, productos = [productoTransporte], catalogoRechazado = false } = opts;
    if (catalogoRechazado) {
      vi.mocked(fetchSiigoProductos).mockRejectedValue(new Error("403"));
    } else {
      vi.mocked(fetchSiigoProductos).mockResolvedValue({
        productos,
        total: productos.length,
        ultimaSync: null,
      });
    }
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <EditorLineas
          borrador={row}
          tramiteId="tramite-1"
          puedeEditar={puedeEditar}
          onBorradorActualizado={vi.fn()}
        />,
      );
    });
  }

  async function remontarConProducto(row: BorradorRow, puedeEditar = true) {
    await remontar(row, { puedeEditar });
  }

  // El aria-label ahora incluye el valor actual ("…línea N: <texto o "Sin
  // producto SIIGO">"), así que se busca por prefijo — con el `:` para no
  // confundir "línea 1" con "línea 10".
  function botonProducto(orden: number) {
    return container.querySelector<HTMLButtonElement>(
      `button[aria-label^="Producto Siigo de la línea ${orden}:"]`,
    );
  }

  it("línea sin producto muestra el aviso por línea y el aviso general", async () => {
    await remontarConProducto(borradorCon([lineaBase({})]));
    expect(container.textContent).toContain("Sin producto SIIGO: no se podrá enviar.");
    expect(container.textContent).toContain("1 línea(s) sin producto SIIGO");
  });

  it("elegir un producto llama actualizarLinea SOLO con siigoProductoId (nunca pisa el concepto)", async () => {
    vi.mocked(actualizarLinea).mockResolvedValue(borradorCon([lineaBase({})]));
    await remontarConProducto(borradorCon([lineaBase({})]));
    const boton = botonProducto(1)!;
    await act(async () => boton.click());
    const opcion = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("TR01 — TRANSPORTE"),
    )!;
    await act(async () => opcion.click());
    expect(actualizarLinea).toHaveBeenCalledWith("draft-1", "line-1", { siigoProductoId: "p1" });
  });

  it('una línea con producto: "Quitar selección" limpia el producto', async () => {
    vi.mocked(actualizarLinea).mockResolvedValue(
      borradorCon([lineaBase({ siigoProductoId: "p1", siigoProductoCodigo: "TR01" })]),
    );
    await remontarConProducto(
      borradorCon([lineaBase({ siigoProductoId: "p1", siigoProductoCodigo: "TR01" })]),
    );
    const boton = botonProducto(1)!;
    await act(async () => boton.click());
    const quitar = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Quitar selección",
    )!;
    await act(async () => quitar.click());
    expect(actualizarLinea).toHaveBeenCalledWith("draft-1", "line-1", { siigoProductoId: null });
  });

  it("línea fija IMPUESTO_4X1000 con producto: el selector sigue disponible, con la nota de que es el valor por defecto", async () => {
    await remontarConProducto(
      borradorCon([
        lineaBase({
          tipoFija: "IMPUESTO_4X1000",
          seccion: "TERCEROS",
          siigoProductoId: "p1",
          siigoProductoCodigo: "TR01",
        }),
      ]),
    );
    expect(botonProducto(1)).not.toBeNull();
    expect(container.textContent).toContain(
      "Producto por defecto del sistema; cámbialo solo si está mal.",
    );
  });

  it("línea fija IMPUESTO_4X1000 sin producto: rescate con selector", async () => {
    await remontarConProducto(
      borradorCon([lineaBase({ tipoFija: "IMPUESTO_4X1000", seccion: "TERCEROS" })]),
    );
    expect(botonProducto(1)).not.toBeNull();
  });

  it("IVA_COMISION en CONCEPTOS_IVA sin producto: sin selector ni aviso (no viaja a Siigo)", async () => {
    await remontarConProducto(
      borradorCon(
        [
          lineaBase({
            tipoFija: "IVA_COMISION",
            seccion: "OPERACIONAL",
            valor: "19000.00",
          }),
        ],
        "CONCEPTOS_IVA",
      ),
    );
    expect(botonProducto(1)).toBeNull();
    expect(container.textContent).not.toContain("Sin producto SIIGO: no se podrá enviar.");
    expect(container.textContent).not.toContain("línea(s) sin producto SIIGO");
  });

  it("con puedeEditar=false se ve el aviso pero no el selector", async () => {
    await remontarConProducto(borradorCon([lineaBase({})]), false);
    expect(container.textContent).toContain("1 línea(s) sin producto SIIGO");
    expect(container.textContent).toContain(
      "Pide a un ADMIN o REVISOR que devuelva el borrador a BORRADOR para asignar el producto.",
    );
    expect(botonProducto(1)).toBeNull();
  });

  // ── Hallazgo: el menú del selector de producto quedaba recortado por el
  // `overflow-x-auto` de la tabla (absolute + scroll vertical implícito). ──
  describe("Menú del selector de producto: en el flujo dentro de la tabla, superpuesto fuera de ella", () => {
    it("en una línea existente (dentro de la tabla con scroll) el menú se abre en el flujo, no superpuesto", async () => {
      await remontarConProducto(borradorCon([lineaBase({})]));
      const boton = botonProducto(1)!;
      await act(async () => boton.click());
      const menu = boton.closest("div.relative.inline-block")!.querySelector("div.max-h-96")!;
      expect(menu.className).toContain("relative");
      expect(menu.className).toContain("z-20");
      expect(menu.className).not.toMatch(/(^|\s)absolute(\s|$)/);
    });

    it('en el formulario "Nueva línea" (fuera de la tabla) el menú sigue superpuesto', async () => {
      await remontarConProducto(borradorCon([]));
      const botonNuevo = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "— Seleccionar —",
      )!;
      await act(async () => botonNuevo.click());
      const menu = botonNuevo.closest("div.relative.inline-block")!.querySelector("div.max-h-96")!;
      expect(menu.className).toContain("absolute");
      expect(menu.className).toContain("z-30");
    });
  });

  // ── Hallazgo: el botón mostraba "Sin producto SIIGO" cuando el catálogo no
  // traía el producto de la línea (403 por rol, carga en curso o fallida, o
  // producto inactivo) — aunque la línea sí lo tuviera. ──
  describe("Catálogo sin el producto de la línea (403 por rol, carga fallida, producto inactivo)", () => {
    it("catálogo cargado pero sin ese producto: el botón muestra el código/nombre guardados en la línea, no «Sin producto SIIGO»", async () => {
      await remontarConProducto(
        borradorCon([
          lineaBase({
            siigoProductoId: "id-viejo",
            siigoProductoCodigo: "TR99",
            siigoProductoNombre: "TRANSPORTE DESCONTINUADO",
          }),
        ]),
      );
      const boton = botonProducto(1)!;
      expect(boton.textContent).toContain("TR99 — TRANSPORTE DESCONTINUADO");
      expect(boton.textContent).not.toContain("Sin producto SIIGO");
    });

    it("catálogo vacío (p. ej. SOCIO recibe 403 del catálogo) y línea con producto: texto de solo lectura con el código, sin selector ni «Quitar selección»", async () => {
      await remontar(
        borradorCon([
          lineaBase({
            siigoProductoId: "p1",
            siigoProductoCodigo: "TR01",
            siigoProductoNombre: "TRANSPORTE",
          }),
        ]),
        { productos: [] },
      );
      expect(botonProducto(1)).toBeNull();
      expect(container.textContent).toContain("TR01");
      expect(container.textContent).not.toContain("Sin producto SIIGO");
      expect(container.textContent).not.toContain("Quitar selección");
    });

    it("catálogo vacío y línea sin producto: se mantiene el aviso honesto, pero no se ofrece un selector sin opciones", async () => {
      await remontar(borradorCon([lineaBase({})]), { productos: [] });
      expect(botonProducto(1)).toBeNull();
      expect(container.textContent).toContain("Sin producto SIIGO: no se podrá enviar.");
    });
  });

  // ── Hallazgo: el aviso no distinguía el estado del borrador ni la causa
  // del solo lectura (imposible devolver un FACTURADO a BORRADOR; un
  // BORRADOR ya está en BORRADOR). ──
  describe("Aviso de producto según el estado del borrador", () => {
    it("FACTURADO: no se muestra ningún aviso de producto, aunque falte", async () => {
      await remontarConProducto(
        borradorCon([lineaBase({})], "COMISION", "FACTURADO"),
        false,
      );
      expect(container.textContent).not.toContain("línea(s) sin producto SIIGO");
      expect(container.textContent).not.toContain("Sin producto SIIGO: no se podrá enviar.");
    });

    it("BORRADOR sin poder editar (p. ej. rol OPERATIVO): pide que un ADMIN asigne el producto, no que se devuelva a BORRADOR", async () => {
      await remontarConProducto(
        borradorCon([lineaBase({})], "COMISION", "BORRADOR"),
        false,
      );
      expect(container.textContent).toContain("Pide a un ADMIN que asigne el producto.");
      expect(container.textContent).not.toContain("devuelve el borrador a BORRADOR");
    });

    it("EN_REVISION sin poder editar: pide que un ADMIN asigne el producto", async () => {
      await remontarConProducto(
        borradorCon([lineaBase({})], "COMISION", "EN_REVISION"),
        false,
      );
      expect(container.textContent).toContain("Pide a un ADMIN que asigne el producto.");
      expect(container.textContent).not.toContain("devuelve el borrador a BORRADOR");
    });

    it("APROBADO sin poder editar: pide a un ADMIN o REVISOR que devuelva el borrador a BORRADOR (única devolución válida desde aquí)", async () => {
      await remontarConProducto(
        borradorCon([lineaBase({})], "COMISION", "APROBADO"),
        false,
      );
      expect(container.textContent).toContain(
        "Pide a un ADMIN o REVISOR que devuelva el borrador a BORRADOR para asignar el producto.",
      );
    });
  });

  // ── Hallazgo (revisión 23/24-sep): el aviso se decidía solo con
  // `puedeEditar`, sin mirar si el catálogo de verdad estaba disponible. Un
  // SOCIO como Lucho tiene `puedeEditar=true` en BORRADOR/EN_REVISION, pero
  // `/api/configuracion/siigo/productos` exige rol ADMIN: para él el catálogo
  // siempre rechaza (403), no hay ningún selector en pantalla, y aun así veía
  // "Elige el producto en cada línea marcada" — una acción que no puede
  // hacer. Lo mismo pasaba mientras el catálogo estaba cargando. ──
  describe("Aviso de producto cuando el catálogo no está disponible (403 por rol, red caída)", () => {
    it("puedeEditar=true pero el catálogo fue rechazado (caso Lucho/SOCIO): pide que un ADMIN asigne el producto, nunca 'elige el producto aquí'", async () => {
      await remontar(borradorCon([lineaBase({})], "COMISION", "BORRADOR"), {
        puedeEditar: true,
        catalogoRechazado: true,
      });
      expect(container.textContent).toContain("1 línea(s) sin producto SIIGO");
      expect(container.textContent).toContain("Pide a un ADMIN que asigne el producto.");
      expect(container.textContent).not.toContain("Elige el producto en cada línea marcada");
      expect(botonProducto(1)).toBeNull();
    });

    it("puedeEditar=true, catálogo rechazado, EN_REVISION: mismo texto honesto de 'pide a un ADMIN'", async () => {
      await remontar(borradorCon([lineaBase({})], "COMISION", "EN_REVISION"), {
        puedeEditar: true,
        catalogoRechazado: true,
      });
      expect(container.textContent).toContain("Pide a un ADMIN que asigne el producto.");
      expect(container.textContent).not.toContain("Elige el producto en cada línea marcada");
    });
  });
});
