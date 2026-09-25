import { describe, expect, it } from "vitest";
import { hoyBogota } from "../hoy-bogota";

describe("hoyBogota", () => {
  it("a las 23:00 de Colombia sigue siendo el mismo día (en UTC ya es el siguiente)", () => {
    expect(hoyBogota(new Date("2026-09-25T04:00:00.000Z"))).toBe("2026-09-24");
  });

  it("de día coincide con la fecha UTC", () => {
    expect(hoyBogota(new Date("2026-09-24T15:00:00.000Z"))).toBe("2026-09-24");
  });
});
