/**
 * Test unitario del guard transversal de trámite cerrado (sin BD real —
 * `db` se mockea con vi.fn()). Ver src/lib/tramites/guard.ts.
 */
import { EstadoTramite } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { assertTramiteModificable, TramiteCerradoError } from "../guard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockDb(tramite: unknown): any {
  return {
    tramiteDO: {
      findUnique: vi.fn().mockResolvedValue(tramite),
    },
  };
}

describe("assertTramiteModificable", () => {
  it("no lanza cuando el trámite (objeto ya cargado) no está CERRADO", async () => {
    await expect(
      assertTramiteModificable(mockDb(null), {
        id: "t1",
        consecutivo: "DO.BAQ26-0001",
        estado: EstadoTramite.EN_TRAMITE,
      }),
    ).resolves.toBeUndefined();
  });

  it("lanza TramiteCerradoError cuando el trámite (objeto ya cargado) está CERRADO", async () => {
    const tramite = { id: "t1", consecutivo: "DO.BAQ26-0001", estado: EstadoTramite.CERRADO };

    await expect(assertTramiteModificable(mockDb(null), tramite)).rejects.toThrow(
      TramiteCerradoError,
    );

    try {
      await assertTramiteModificable(mockDb(null), tramite);
      expect.fail("Debió lanzar TramiteCerradoError");
    } catch (error) {
      expect(error).toBeInstanceOf(TramiteCerradoError);
      const err = error as TramiteCerradoError;
      expect(err.status).toBe(409);
      expect(err.tramiteId).toBe("t1");
      expect(err.message).toBe(
        "El trámite DO.BAQ26-0001 está cerrado y no admite modificaciones",
      );
    }
  });

  it("cuando recibe un tramiteId (string), consulta la BD y no lanza si no está CERRADO", async () => {
    const db = mockDb({ id: "t2", consecutivo: "DO.CTG26-0002", estado: EstadoTramite.PAGADO });

    await expect(assertTramiteModificable(db, "t2")).resolves.toBeUndefined();
    expect(db.tramiteDO.findUnique).toHaveBeenCalledWith({
      where: { id: "t2" },
      select: { id: true, consecutivo: true, estado: true },
    });
  });

  it("cuando recibe un tramiteId (string) de un trámite CERRADO, lanza TramiteCerradoError", async () => {
    const db = mockDb({ id: "t3", consecutivo: "DO.SMR26-0003", estado: EstadoTramite.CERRADO });

    await expect(assertTramiteModificable(db, "t3")).rejects.toThrow(TramiteCerradoError);
  });

  it("cuando el trámite no existe (fetch por id devuelve null), no lanza — el caller maneja 'no encontrado'", async () => {
    const db = mockDb(null);

    await expect(assertTramiteModificable(db, "id-inexistente")).resolves.toBeUndefined();
  });
});
