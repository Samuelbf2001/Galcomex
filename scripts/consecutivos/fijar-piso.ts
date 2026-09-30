/**
 * Fija un PISO de consecutivo (30-sep-2026, DISENO-NUMERACION.md §2.1 y §7):
 * «el último número de este contador es por lo menos N». Se usa cuando Camila
 * abrió DOs fuera de la plataforma: así la plataforma no vuelve a entregarlos.
 *
 *   npx tsx scripts/consecutivos/fijar-piso.ts \
 *     --tipo IMPORTACION --anio 2026 --ciudad BGT --ultimo 290 \
 *     --motivo "Camila abrió hasta el DO.BGT26-0290 fuera de la plataforma (duda 3)" \
 *     [--aplicar --admin camila@galcomex.com]
 *
 * - SIMULACRO por defecto: calcula la clave del contador, muestra el número
 *   que sigue hoy y el que seguiría con el piso, y no escribe nada.
 * - `--aplicar` exige `--admin <correo>` de un usuario ADMIN activo: inserta el
 *   piso dentro del candado del contador (el mismo de `createTramite`) y deja
 *   AuditLog `FIJAR_PISO_CONSECUTIVO`.
 * - Barranquilla, Bogotá y Buenaventura comparten contador: un piso con
 *   cualquiera de las tres ciudades es el piso del grupo.
 * - Rechaza un piso menor o igual a lo que el contador ya tiene y un motivo de
 *   menos de 10 caracteres.
 *
 * Usa la base de DATABASE_URL. Nunca imprime la cadena de conexión completa.
 */
import "dotenv/config";

import { Ciudad } from "@prisma/client";

import { prisma } from "../../src/lib/db/prisma";
import { fijarPisoConsecutivo } from "../../src/lib/tramites/pisos";

function valorDe(bandera: string): string | null {
  const i = process.argv.indexOf(bandera);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function baseDeDatos(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${u.hostname}:${u.port}${u.pathname}`;
  } catch {
    return "(DATABASE_URL no definida o ilegible)";
  }
}

async function main() {
  const tipo = valorDe("--tipo");
  const anio = Number(valorDe("--anio"));
  const ciudadTexto = valorDe("--ciudad");
  const ultimo = Number(valorDe("--ultimo"));
  const motivo = valorDe("--motivo") ?? "";
  const aplicar = process.argv.includes("--aplicar");
  const correoAdmin = valorDe("--admin");

  if (!tipo || !Number.isInteger(anio) || !Number.isInteger(ultimo)) {
    throw new Error("Uso: --tipo CODIGO --anio AAAA [--ciudad BAQ|BGT|BUN|CTG|SMR] --ultimo N --motivo \"…\" [--aplicar --admin correo]");
  }
  const ciudad = ciudadTexto ? (Object.values(Ciudad) as string[]).includes(ciudadTexto) ? (ciudadTexto as Ciudad) : null : null;
  if (ciudadTexto && !ciudad) throw new Error(`Ciudad desconocida: ${ciudadTexto}`);

  let usuarioId: string;
  if (aplicar) {
    if (!correoAdmin) throw new Error("--aplicar exige --admin <correo de un usuario ADMIN>");
    const admin = await prisma.user.findUnique({ where: { email: correoAdmin }, select: { id: true } });
    if (!admin) throw new Error(`No existe el usuario ${correoAdmin}`);
    usuarioId = admin.id;
  } else {
    // En simulacro no se escribe: basta cualquier ADMIN activo para validar.
    const admin = await prisma.user.findFirst({ where: { rol: "ADMIN", activo: true }, select: { id: true } });
    if (!admin) throw new Error("No hay ningún usuario ADMIN activo en esta base");
    usuarioId = admin.id;
  }

  console.log(`Base de datos: ${baseDeDatos()}`);
  console.log(aplicar ? "MODO: APLICAR (escribe)" : "MODO: SIMULACRO (no escribe)");

  const r = await fijarPisoConsecutivo({
    tipoTramiteCodigo: tipo,
    anio,
    ciudad,
    ultimoNumero: ultimo,
    motivo,
    usuarioId,
    aplicar,
  });

  console.log(`Contador: ${r.clave}`);
  console.log(`Último número en DOs: ${r.ultimoActual ?? "ninguno"} · piso actual: ${r.pisoActual ?? "ninguno"}`);
  console.log(`Siguiente hoy: ${r.siguienteAntes}`);
  console.log(`Siguiente con el piso: ${r.siguienteDespues}`);
  console.log(r.aplicado ? `Piso fijado (id ${r.pisoId}) con AuditLog FIJAR_PISO_CONSECUTIVO.` : "Simulacro: no se escribió nada. Repite con --aplicar --admin <correo>.");
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
