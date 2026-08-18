/**
 * Tests de la función pura calcularSaldoGlobal — D2-c
 *
 * "Saldo de caja en Ingresos es por cliente, no global multi-cliente"
 * (`.claude/PENDIENTES.md` D2-c). El bug real no estaba en `saldoCorrido`
 * (correcto: acumulado POR CLIENTE, fila a fila) sino en cómo el frontend lo
 * resumía cuando la vista mezclaba varios clientes — tomaba `saldoCorrido`
 * de la ÚLTIMA fila de la lista unificada como si fuera un total. Esta
 * función es el reemplazo correcto: no toca BD, no requiere PostgreSQL.
 */
import { describe, expect, it } from "vitest";

import { calcularSaldoGlobal, type FilaIngreso } from "../service";

type FilaMinima = Pick<FilaIngreso, "clienteId" | "saldoCorrido">;

function fila(clienteId: string, saldoCorrido: bigint): FilaMinima {
  return { clienteId, saldoCorrido };
}

describe("calcularSaldoGlobal", () => {
  it("un solo cliente: el resultado es idéntico al saldo de ese cliente (caso que ya funcionaba)", () => {
    const filas: FilaMinima[] = [
      fila("c1", 1_000_000n),
      fila("c1", 1_400_000n), // ← última fila del cliente: es su saldo final
    ];

    expect(calcularSaldoGlobal(filas)).toBe(1_400_000n);
  });

  it("varios clientes intercalados cronológicamente: suma el saldo FINAL de cada uno, no la última fila global", () => {
    // Orden cronológico tal como lo entrega getIngresos (ASC por fecha,
    // clientes intercalados). El bug original habría tomado 700.000 (la
    // última fila, que es de c2) como "el saldo" — acá el correcto es la
    // suma de los saldos finales de c1 y c2.
    const filas: FilaMinima[] = [
      fila("c1", 500_000n), // c1 primer movimiento
      fila("c2", 200_000n), // c2 primer movimiento
      fila("c1", 900_000n), // c1 segundo movimiento → saldo final c1 = 900.000
      fila("c2", 700_000n), // c2 segundo movimiento (última fila global) → saldo final c2 = 700.000
    ];

    // Saldo global correcto = 900.000 (c1) + 700.000 (c2) = 1.600.000
    expect(calcularSaldoGlobal(filas)).toBe(1_600_000n);
    // Y NO el bug: tomar solo la última fila (700.000).
    expect(calcularSaldoGlobal(filas)).not.toBe(700_000n);
  });

  it("un cliente con saldo negativo (devoluciones superan entradas) se suma con signo", () => {
    const filas: FilaMinima[] = [
      fila("c1", 1_000_000n),
      fila("c2", -300_000n), // c2 terminó en negativo (más devoluciones que entradas)
    ];

    expect(calcularSaldoGlobal(filas)).toBe(700_000n);
  });

  it("tres clientes: suma los tres saldos finales independientemente del orden de aparición", () => {
    const filas: FilaMinima[] = [
      fila("a", 100_000n),
      fila("b", 50_000n),
      fila("c", 10_000n),
      fila("a", 250_000n), // saldo final a
      fila("b", 90_000n), // saldo final b
      fila("c", 40_000n), // saldo final c
    ];

    expect(calcularSaldoGlobal(filas)).toBe(250_000n + 90_000n + 40_000n);
  });

  it("arreglo vacío devuelve 0n sin lanzar", () => {
    expect(calcularSaldoGlobal([])).toBe(0n);
  });

  it("cliente saldado en 0 no afecta el total de los demás", () => {
    const filas: FilaMinima[] = [
      fila("saldado", 500_000n),
      fila("saldado", 0n), // terminó saldado
      fila("otro", 300_000n),
    ];

    expect(calcularSaldoGlobal(filas)).toBe(300_000n);
  });
});
