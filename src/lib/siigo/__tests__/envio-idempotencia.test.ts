// @vitest-environment node
/**
 * Envío a SIIGO sin duplicados (revisión de seguridad, hallazgo MEDIO).
 *
 * Cada POST a Siigo crea un documento que, estampado, es una factura legal.
 * Sin BD ni red: Prisma y el cliente Siigo están mockeados; el advisory lock
 * `pg_try_advisory_xact_lock` se simula con un flag por transacción.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const estado = {
    estado: "APROBADO",
    siigoDraftId: null as string | null,
    ultimoErrorSiigo: null as string | null,
  };
  const lock = { ocupado: false };
  const fallos = { proximoUpdate: false };
  const auditorias: Array<{ accion: string; despues?: unknown; antes?: unknown }> = [];

  function borradorCompleto() {
    return {
      id: "bor-1",
      estado: estado.estado,
      siigoDraftId: estado.siigoDraftId,
      formaPagoSiigoId: 7,
      formatoFactura: "COMISION",
      retenciones: 0n,
      reteIvaPorcentaje: null,
      comentariosCabecera: null,
      totalFactura: 1_000_000n,
      totalAnticipo: 0n,
      saldoAFavorCliente: 0n,
      saldoACargoCliente: 1_000_000n,
      tramite: {
        id: "tra-1",
        consecutivo: "DO.BAQ26-0001",
        cliente: { nit: "900123456", nombre: "Cliente Prueba" },
        pagos: [],
      },
      formaPago: null,
      lineasRevision: [],
    };
  }

  const findUnique = vi.fn(async () => borradorCompleto());

  function crearTx(estadoTx: { tengoLock: boolean }) {
    return {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => {
        if (lock.ocupado) return [{ tomado: false }];
        lock.ocupado = true;
        estadoTx.tengoLock = true;
        return [{ tomado: true }];
      }),
      borradorFactura: {
        findUnique,
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (fallos.proximoUpdate) {
            fallos.proximoUpdate = false;
            throw new Error("Transaction already closed");
          }
          Object.assign(estado, data);
          return {};
        }),
      },
      auditLog: {
        create: vi.fn(async ({ data }: { data: { accion: string } }) => {
          auditorias.push(data);
          return {};
        }),
      },
    };
  }

  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const estadoTx = { tengoLock: false };
    try {
      return await fn(crearTx(estadoTx));
    } finally {
      if (estadoTx.tengoLock) lock.ocupado = false;
    }
  });

  return { estado, lock, fallos, auditorias, findUnique, $transaction, borradorCompleto };
});

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: h.$transaction,
    borradorFactura: { findUnique: h.findUnique },
    parametro: {
      findMany: vi.fn(async () => [
        { clave: "SIIGO_TIPO_COMPROBANTE_ID", valor: "101" },
        { clave: "SIIGO_VENDEDOR_ID", valor: "202" },
      ]),
    },
    siigoImpuesto: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/borradores/lineas-fijas", () => ({ ensureLineasFijas: vi.fn(async () => {}) }));
vi.mock("@/lib/borradores/recalculo", () => ({ recalcularTotalBorrador: vi.fn(async () => {}) }));
vi.mock("@/lib/borradores/devolver", () => ({ esObservacionDevolucion: () => false }));
vi.mock("@/lib/borradores/formato-conceptos", () => ({ FORMATO_CONCEPTOS_IVA: "CONCEPTOS_IVA" }));
vi.mock("@/lib/parametros/service", () => ({ getParametrosSistema: vi.fn() }));

const siigo = vi.hoisted(() => ({
  getToken: vi.fn(async () => "token-prueba"),
  postFactura: vi.fn(),
}));

vi.mock("@/lib/siigo/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/siigo/client")>()),
  getToken: siigo.getToken,
  postFactura: siigo.postFactura,
}));

const {
  enviarBorradorASiigo,
  motivoRechazoEnvioSiigo,
  MENSAJE_ENVIO_EN_CURSO,
} = await import("../envio-factura-service");
const { SiigoApiError } = await import("../client");

function respuestaSiigo(id: string) {
  return { id, name: `BAQ-${id}`, date: "2026-09-22" };
}

beforeEach(() => {
  h.estado.estado = "APROBADO";
  h.estado.siigoDraftId = null;
  h.estado.ultimoErrorSiigo = null;
  h.lock.ocupado = false;
  h.fallos.proximoUpdate = false;
  h.auditorias.length = 0;
  h.findUnique.mockClear();
  h.$transaction.mockClear();
  siigo.getToken.mockClear();
  siigo.postFactura.mockReset();
});

describe("motivoRechazoEnvioSiigo (regla pura)", () => {
  it("primer envío: permitido sin siigoDraftId", () => {
    expect(motivoRechazoEnvioSiigo({ siigoDraftId: null })).toBeNull();
  });

  it("ya enviado y sin reenvío explícito: rechazado", () => {
    expect(motivoRechazoEnvioSiigo({ siigoDraftId: "sg-1" })).toMatch(/ya se envió a SIIGO/);
  });

  it("reenvío que nombra el borrador vigente: permitido", () => {
    expect(
      motivoRechazoEnvioSiigo({ siigoDraftId: "sg-1" }, { reenviar: true, siigoDraftIdAnterior: "sg-1" }),
    ).toBeNull();
  });

  it("reenvío con un id viejo (alguien reenvió en medio): rechazado", () => {
    expect(
      motivoRechazoEnvioSiigo({ siigoDraftId: "sg-2" }, { reenviar: true, siigoDraftIdAnterior: "sg-1" }),
    ).toMatch(/se volvió a enviar/);
  });

  it("reenvío sin decir cuál reemplaza: rechazado", () => {
    expect(motivoRechazoEnvioSiigo({ siigoDraftId: "sg-1" }, { reenviar: true })).toMatch(
      /indicar cuál borrador/,
    );
  });
});

describe("enviarBorradorASiigo — anti-duplicado", () => {
  it("primer envío: un POST, guarda el id y audita", async () => {
    siigo.postFactura.mockResolvedValueOnce(respuestaSiigo("sg-1"));

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: true, siigoDraftId: "sg-1" });
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    expect(h.estado.siigoDraftId).toBe("sg-1");
    expect(h.auditorias.map((a) => a.accion)).toEqual(["SIIGO_ENVIAR_OK"]);
    expect(h.lock.ocupado).toBe(false);
  });

  it("segundo envío (doble clic / reintento) sin «Reenviar»: rechazado sin tocar Siigo", async () => {
    siigo.postFactura.mockResolvedValueOnce(respuestaSiigo("sg-1"));
    await enviarBorradorASiigo("bor-1", "usr-1");

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "estado" });
    expect(r.ok ? "" : r.error).toMatch(/ya se envió a SIIGO \(borrador sg-1\)/);
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    expect(h.estado.siigoDraftId).toBe("sg-1");
  });

  it("dos envíos simultáneos: el segundo recibe «en curso» y solo hay un POST", async () => {
    let responder: (v: ReturnType<typeof respuestaSiigo>) => void = () => {};
    siigo.postFactura.mockImplementationOnce(
      () => new Promise((resolve) => (responder = resolve)),
    );

    const primero = enviarBorradorASiigo("bor-1", "usr-1");
    await vi.waitFor(() => expect(siigo.postFactura).toHaveBeenCalledTimes(1));

    const segundo = await enviarBorradorASiigo("bor-1", "usr-1");
    expect(segundo).toEqual({ ok: false, tipo: "estado", error: MENSAJE_ENVIO_EN_CURSO });

    responder(respuestaSiigo("sg-1"));
    await expect(primero).resolves.toMatchObject({ ok: true, siigoDraftId: "sg-1" });
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    expect(h.auditorias.filter((a) => a.accion === "SIIGO_ENVIAR_OK")).toHaveLength(1);
  });

  it("la comprobación que cuenta es la de bajo el lock (id guardado entre la lectura y el lock)", async () => {
    // Lectura previa: aún sin id. Dentro del lock: otro envío ya lo guardó.
    h.estado.siigoDraftId = "sg-9";
    h.findUnique.mockImplementationOnce(async () => ({
      ...h.borradorCompleto(),
      siigoDraftId: null,
    }));

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "estado" });
    expect(siigo.postFactura).not.toHaveBeenCalled();
  });

  it("«Reenviar» explícito crea otro borrador; repetirlo con el mismo id viejo se rechaza", async () => {
    h.estado.siigoDraftId = "sg-1";
    siigo.postFactura.mockResolvedValueOnce(respuestaSiigo("sg-2"));

    const reenvio = await enviarBorradorASiigo("bor-1", "usr-1", {
      reenviar: true,
      siigoDraftIdAnterior: "sg-1",
    });
    expect(reenvio).toMatchObject({ ok: true, siigoDraftId: "sg-2" });
    expect(h.auditorias[0]).toMatchObject({
      accion: "SIIGO_ENVIAR_OK",
      antes: { siigoDraftIdAnterior: "sg-1" },
      despues: { siigoDraftId: "sg-2", reenvio: true },
    });

    const repetido = await enviarBorradorASiigo("bor-1", "usr-1", {
      reenviar: true,
      siigoDraftIdAnterior: "sg-1",
    });
    expect(repetido).toMatchObject({ ok: false, tipo: "estado" });
    expect(repetido.ok ? "" : repetido.error).toMatch(/borrador actual sg-2/);
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
  });

  it("si Siigo rechaza: guarda el error, no el id, y libera el lock para reintentar", async () => {
    siigo.postFactura.mockRejectedValueOnce(new SiigoApiError("Siigo POST falló con HTTP 400", 400));

    const fallo = await enviarBorradorASiigo("bor-1", "usr-1");
    expect(fallo).toMatchObject({ ok: false, tipo: "api" });
    expect(h.estado.siigoDraftId).toBeNull();
    expect(h.estado.ultimoErrorSiigo).toMatch(/HTTP 400/);
    expect(h.lock.ocupado).toBe(false);

    siigo.postFactura.mockResolvedValueOnce(respuestaSiigo("sg-1"));
    await expect(enviarBorradorASiigo("bor-1", "usr-1")).resolves.toMatchObject({ ok: true });
  });

  it("si Siigo no responde a tiempo: mensaje en español que pide revisar el portal", async () => {
    siigo.postFactura.mockRejectedValueOnce(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "api" });
    expect(r.ok ? "" : r.error).toMatch(/no respondió .* revisa en el portal de SIIGO/);
    expect(siigo.postFactura.mock.calls[0]![2]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("si Siigo creó el borrador pero la transacción falla al guardar: se reintenta guardar el id", async () => {
    siigo.postFactura.mockResolvedValueOnce(respuestaSiigo("sg-1"));
    h.fallos.proximoUpdate = true;

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: true, siigoDraftId: "sg-1" });
    expect(h.estado.siigoDraftId).toBe("sg-1");
    // Y un envío posterior ya no duplica.
    await expect(enviarBorradorASiigo("bor-1", "usr-1")).resolves.toMatchObject({ ok: false });
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
  });

  it("borrador que ya no está APROBADO: rechazado antes de llamar a Siigo", async () => {
    h.estado.estado = "EN_REVISION";

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "estado" });
    expect(siigo.postFactura).not.toHaveBeenCalled();
  });
});
