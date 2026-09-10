/**
 * Configura en la BD las empresas de la reunión de tarifas y cartera con las
 * funciones que Camila describió, para que el sistema se comporte con cada una
 * como ella explicó — sin una sola rama nueva en el código.
 *
 *   npx tsx scripts/configurar-clientes-reunion.ts             # empresas + funciones
 *   npx tsx scripts/configurar-clientes-reunion.ts --ejemplos  # además, dos casos de ejemplo
 *
 * Idempotente: se puede correr las veces que haga falta.
 *
 * Cómo trata a cada empresa:
 *   · Si ya existe una (y solo una) con ese nombre, la reutiliza y le ajusta
 *     roles y funciones. NUNCA le cambia el NIT ni el `tipo`.
 *   · Si no existe, la crea con NIT `PENDIENTE-NIT-<CLAVE>` para que quede a la
 *     vista que Camila debe completarlo desde la ficha. No se inventan NITs.
 *   · Si hay varias con ese nombre, la salta y avisa: mejor no adivinar.
 *   · Ignora las empresas de la demo (`DEMO ...`) y las de prueba.
 *
 * Lo que NO decide este script (queda en PENDIENTES-MARIA-CAMILA.md):
 *   · El valor de la comisión por contenedor de Eltrans (no se dijo en la reunión).
 *   · Si Sesderma e Inversiones Triplex pertenecen al grupo Polired.
 *   · El NIT de Ascinter (hay dos candidatos).
 */

import "dotenv/config";

import {
  OrigenMovimientoCuenta,
  RolCuenta,
  TipoMovimientoCuenta,
  Ciudad,
} from "@prisma/client";

import { capacidadesActivas } from "../src/lib/capacidades/resolver";
import { capacidadesDeEmpresa, setCapacidadesEmpresa } from "../src/lib/capacidades/service";
import { registrarMovimientoCuenta } from "../src/lib/cuenta-corriente/service";
import { prisma } from "../src/lib/db/prisma";
import { createTramite } from "../src/lib/tramites/service";

const MARCA_EJEMPLO = "[EJEMPLO REUNIÓN]";
const NOMBRE_GRUPO_POLIRED = "Grupo Polired";

// ─── Lo que se dijo en la reunión, empresa por empresa ────────────────────────

type Capacidad = { codigo: string; habilitado: boolean; config?: Record<string, unknown> };

type EmpresaReunion = {
  clave: string;
  /** Nombre con el que se crea si no existe. */
  nombre: string;
  /** Palabras que identifican a la empresa en los nombres ya cargados (minúsculas). */
  buscar: string[];
  /** Palabras que EXCLUYEN una coincidencia (p. ej. "zona franca" para Polired matriz). */
  excluir?: string[];
  esCliente: boolean;
  esProveedor: boolean;
  grupo?: "polired";
  capacidades: Capacidad[];
  /** Qué dijo Camila; queda en la salida para poder contrastarlo. */
  fuente: string;
};

const EMPRESAS: EmpresaReunion[] = [
  {
    clave: "LITOPLAS",
    nombre: "LITOPLAS S.A.",
    buscar: ["litoplas"],
    esCliente: true,
    esProveedor: false,
    capacidades: [
      { codigo: "anticipos_cliente", habilitado: true },
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "base_cif", habilitado: false },
      { codigo: "clasificacion_arancelaria", habilitado: true },
      { codigo: "eventos_facturables", habilitado: true },
      { codigo: "docs_bl_factura_obligatorios", habilitado: true },
      {
        codigo: "regla_agencia_fija",
        habilitado: true,
        config: {
          agencia: "MOVIADUANAS",
          formatoDoAgencia: "^I\\d{8}$",
          mensajeAgencia: "Litoplas debe operar con Moviaduanas",
          mensajeFormato: "Litoplas requiere DO de agencia con formato I########",
        },
      },
    ],
    fuente:
      "Pide anticipos (04:25). Tarifas propias, NO usa CIF (37:49). Clasificación arancelaria facturada aparte (14:48). Eventos: despacho con revisión 180k, entrega directa 200k, registro 433k (48:44). Moviaduanas + DO I######## (regla histórica).",
  },
  {
    clave: "CW_EXPRESS",
    nombre: "CW EXPRESS",
    buscar: ["cw express", "cwexpress", "c.w. express", "cw  express"],
    esCliente: true,
    esProveedor: true,
    capacidades: [
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "base_cif", habilitado: true },
      { codigo: "eventos_facturables", habilitado: true },
    ],
    fuente:
      "Servicio logístico = CIF × 0,37% con mínimos por tipo de carga (75:20). Despacho parcial 50k (81:07). También es proveedor (83:37).",
  },
  {
    clave: "POLIRED",
    nombre: "POLIRED SAS",
    buscar: ["polired", "polirred"],
    excluir: ["zona franca", " zf"],
    esCliente: true,
    esProveedor: false,
    grupo: "polired",
    capacidades: [{ codigo: "tarifario_propio", habilitado: true }],
    fuente:
      "Misma casa que Polired Zona Franca (89:02). El nº de contenedores del BL alimenta la comisión de Eltrans (89:27). Se revisa contra orden de compra (pendiente anterior).",
  },
  {
    clave: "POLIRED_ZF",
    nombre: "POLIRED ZONA FRANCA",
    buscar: ["polired zona franca", "polired zf", "polirred zona franca"],
    esCliente: true,
    esProveedor: false,
    grupo: "polired",
    // No declara nada propio: hereda del grupo.
    capacidades: [],
    fuente: "Misma empresa que Polired, dos NIT (89:02).",
  },
  {
    clave: "SESDERMA",
    nombre: "SESDERMA",
    buscar: ["sesderma", "setderma"],
    esCliente: true,
    esProveedor: false,
    capacidades: [{ codigo: "tarifario_propio", habilitado: true }],
    fuente:
      "Cliente propio con DOs (frame 16:03, DO.BIGT26-0244). Ascinter le factura transporte (60:05). ¿Grupo Polired? — no se dijo.",
  },
  {
    clave: "COLDEX",
    nombre: "COLDEX",
    buscar: ["coldex"],
    esCliente: true,
    esProveedor: true,
    capacidades: [
      { codigo: "anticipos_cliente", habilitado: false },
      { codigo: "cargos_manuales_contraparte", habilitado: true },
    ],
    fuente:
      "Agencia de aduanas: proveedor, pero también se le hacen trámites (liberación de BLs). Mensualidad variable ~4M por servicios aduaneros + quincenas y primas (68:45, 72:50).",
  },
  {
    clave: "ELTRANS",
    nombre: "ELTRANS",
    buscar: ["eltrans", "el trans", "eltran"],
    esCliente: true,
    esProveedor: true,
    capacidades: [
      { codigo: "anticipos_cliente", habilitado: false },
      { codigo: "contenedores_obligatorio", habilitado: true },
      {
        codigo: "comision_por_evento",
        habilitado: true,
        // El valor por contenedor NO se dijo en la reunión: queda en 0 a la vista.
        config: { unidad: "CONTENEDOR", valor: "0" },
      },
    ],
    fuente:
      "Proveedor de Polired que le paga a Galcomex una comisión por contenedor (84:02–89:27). Para Camila es 'un cliente que te va a pagar una comisión' (86:32).",
  },
  {
    clave: "ASCINTER",
    nombre: "ASCINTER",
    buscar: ["ascinter", "asinter", "acinter"],
    esCliente: true,
    esProveedor: true,
    capacidades: [{ codigo: "anticipos_cliente", habilitado: false }],
    fuente:
      "Proveedor (asesoría a nombre de Galcomex, transporte trasladable) y fue cliente el año pasado (58:50). Pendiente: Guillermo decide si vuelve a serlo.",
  },
  {
    clave: "ALMACARGA",
    nombre: "ALMACARGA",
    buscar: ["almacarga"],
    esCliente: false,
    esProveedor: true,
    capacidades: [{ codigo: "anticipos_cliente", habilitado: false }],
    fuente: "Proveedor de almacenaje, solo le presta a Litoplas; se paga en bloque a mitad de mes (53:09).",
  },
];

/** Funciones que el grupo Polired enciende para todas sus empresas. */
const CAPACIDADES_GRUPO_POLIRED: Capacidad[] = [
  { codigo: "contenedores_obligatorio", habilitado: true },
  { codigo: "eventos_facturables", habilitado: true },
  { codigo: "orden_compra_en_revision", habilitado: true },
];

// ─── Salida ───────────────────────────────────────────────────────────────────

const ok = (t: string) => console.log(`    ✓ ${t}`);
const aviso = (t: string) => console.log(`    ⚠ ${t}`);
const nota = (t: string) => console.log(`      ${t}`);

function titulo(t: string) {
  console.log(`\n${"─".repeat(78)}\n${t}\n${"─".repeat(78)}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function usuarioAdmin(): Promise<string> {
  const camila = await prisma.user.findFirst({
    where: { email: "camila@galcomex.com" },
    select: { id: true },
  });
  if (camila) return camila.id;

  const admin = await prisma.user.findFirst({ where: { rol: "ADMIN" }, select: { id: true } });
  if (!admin) throw new Error("No hay ningún ADMIN en la BD: corre npm run db:seed primero");
  return admin.id;
}

function esDePrueba(nombre: string, nit: string): boolean {
  const n = nombre.toUpperCase();
  return (
    n.startsWith("DEMO") ||
    nit.startsWith("DEMO-") ||
    nit.startsWith("REPLICA-") ||
    nit.startsWith("vitest-")
  );
}

/** Busca la empresa real por nombre. Devuelve `null` si no hay o hay varias. */
async function localizar(
  empresa: EmpresaReunion,
  candidatos: { id: string; nombre: string; nit: string }[],
): Promise<{ id: string; nombre: string; nit: string } | "AMBIGUA" | null> {
  const coincide = (nombre: string) => {
    const bajo = nombre.toLowerCase();
    if (empresa.excluir?.some((x) => bajo.includes(x))) return false;
    return empresa.buscar.some((clave) => bajo.includes(clave));
  };

  const encontradas = candidatos.filter((c) => !esDePrueba(c.nombre, c.nit) && coincide(c.nombre));

  if (encontradas.length === 0) return null;
  if (encontradas.length > 1) return "AMBIGUA";
  return encontradas[0]!;
}

// ─── Principal ────────────────────────────────────────────────────────────────

async function main() {
  const conEjemplos = process.argv.includes("--ejemplos");

  titulo("Configuración de las empresas de la reunión");

  const usuarioId = await usuarioAdmin();
  const catalogo = await prisma.capacidad.count();
  if (catalogo === 0) {
    console.error("✗ El catálogo de capacidades está vacío. Aplica las migraciones y el seed.");
    process.exitCode = 1;
    return;
  }

  // ── Grupo económico ────────────────────────────────────────────────────────
  const grupoPolired = await prisma.grupoEmpresa.upsert({
    where: { nombre: NOMBRE_GRUPO_POLIRED },
    update: {},
    create: { nombre: NOMBRE_GRUPO_POLIRED },
  });

  for (const cap of CAPACIDADES_GRUPO_POLIRED) {
    await prisma.grupoEmpresaCapacidad.upsert({
      where: { grupoId_codigo: { grupoId: grupoPolired.id, codigo: cap.codigo } },
      update: { habilitado: cap.habilitado },
      create: { grupoId: grupoPolired.id, codigo: cap.codigo, habilitado: cap.habilitado },
    });
  }
  ok(
    `${NOMBRE_GRUPO_POLIRED}: enciende ${CAPACIDADES_GRUPO_POLIRED.map((c) => c.codigo).join(", ")} para todas sus empresas.`,
  );

  // ── Empresas ───────────────────────────────────────────────────────────────
  const existentes = await prisma.cliente.findMany({
    select: { id: true, nombre: true, nit: true },
  });

  const ids = new Map<string, string>();
  const resumen: string[][] = [];

  for (const empresa of EMPRESAS) {
    console.log(`\n▸ ${empresa.nombre}`);
    nota(empresa.fuente);

    const localizada = await localizar(empresa, existentes);
    let id: string;
    let origen: string;

    if (localizada === "AMBIGUA") {
      aviso(`Hay varias empresas que coinciden con "${empresa.buscar[0]}": se salta para no adivinar.`);
      resumen.push([empresa.nombre, "SALTADA (ambigua)", "", ""]);
      continue;
    }

    if (localizada) {
      id = localizada.id;
      origen = `reutilizada · ${localizada.nombre} · NIT ${localizada.nit}`;
      await prisma.cliente.update({
        where: { id },
        data: {
          esCliente: empresa.esCliente,
          esProveedor: empresa.esProveedor,
          grupoEmpresaId: empresa.grupo === "polired" ? grupoPolired.id : undefined,
        },
      });
    } else {
      const nit = `PENDIENTE-NIT-${empresa.clave}`;
      const creada = await prisma.cliente.create({
        data: {
          nombre: empresa.nombre,
          nit,
          tipo: "PROPIO",
          esCliente: empresa.esCliente,
          esProveedor: empresa.esProveedor,
          grupoEmpresaId: empresa.grupo === "polired" ? grupoPolired.id : null,
        },
      });
      id = creada.id;
      origen = `CREADA · NIT ${nit} — Camila debe completar el NIT real desde la ficha`;
    }
    ids.set(empresa.clave, id);
    ok(origen);

    if (empresa.capacidades.length > 0) {
      await setCapacidadesEmpresa({
        empresaId: id,
        cambios: empresa.capacidades.map((c) => ({
          codigo: c.codigo as never,
          habilitado: c.habilitado,
          config: c.config,
        })),
        usuarioId,
      });
    }

    const efectivas = capacidadesActivas(await capacidadesDeEmpresa(id));
    ok(`Funciones activas: ${efectivas.join(", ") || "ninguna"}`);

    resumen.push([
      empresa.nombre,
      localizada ? "reutilizada" : "creada",
      [empresa.esCliente ? "cliente" : "", empresa.esProveedor ? "proveedor" : ""].filter(Boolean).join("+"),
      efectivas.join(", ") || "—",
    ]);
  }

  // ── Puente beneficiario → empresa (cuenta corriente) ───────────────────────
  console.log("\n▸ Beneficiarios de pago enlazados a su ficha de empresa");
  const beneficiarios = await prisma.beneficiario.findMany({
    where: { empresaId: null },
    select: { id: true, nombre: true, nit: true },
  });
  let enlazados = 0;
  for (const empresa of EMPRESAS) {
    const empresaId = ids.get(empresa.clave);
    if (!empresaId || !empresa.esProveedor) continue;

    for (const b of beneficiarios) {
      if (esDePrueba(b.nombre, b.nit ?? "")) continue;
      const bajo = b.nombre.toLowerCase();
      if (empresa.buscar.some((k) => bajo.includes(k))) {
        await prisma.beneficiario.update({ where: { id: b.id }, data: { empresaId } });
        ok(`${b.nombre} → ${empresa.nombre}`);
        enlazados += 1;
      }
    }
  }
  if (enlazados === 0) {
    nota("Ningún beneficiario suelto coincidió por nombre. Los que se creen desde ahora se enlazan desde la ficha.");
  }

  // ── Ejemplos ───────────────────────────────────────────────────────────────
  if (conEjemplos) {
    titulo("Ejemplos");

    const litoplasId = ids.get("LITOPLAS");
    if (litoplasId) {
      const yaExiste = await prisma.tramiteDO.findFirst({
        where: { clienteId: litoplasId, tipoTramiteCodigo: "CLASIFICACION", comentarios: { contains: MARCA_EJEMPLO } },
        select: { consecutivo: true },
      });
      if (yaExiste) {
        ok(`Clasificación de ejemplo ya existe: ${yaExiste.consecutivo}`);
      } else {
        // Datos literales del informe que se vio en pantalla en la reunión (22:12).
        const clas = await createTramite({
          ciudad: Ciudad.BAQ,
          clienteId: litoplasId,
          tipoTramiteCodigo: "CLASIFICACION",
          referenciaExterna: "2140",
          comentarios: `${MARCA_EJEMPLO} Informe de clasificación 2140 del 16/07/2026 · Generador de aire caliente a gas · subpartida 7322.90.00.00 · tarifa 380.000 + IVA`,
          creadoPorId: usuarioId,
        });
        ok(`Clasificación arancelaria para Litoplas: ${clas.consecutivo} (informe externo 2140)`);
        nota("Consecutivo propio, sin ETA ni agencia, factura aparte. Tal como se acordó en 26:26.");
      }
    }

    const coldexId = ids.get("COLDEX");
    if (coldexId) {
      const yaExiste = await prisma.movimientoCuenta.findFirst({
        where: { empresaId: coldexId, concepto: { contains: MARCA_EJEMPLO } },
        select: { id: true },
      });
      if (yaExiste) {
        ok("Cargo manual de ejemplo para Coldex ya existe.");
      } else {
        await registrarMovimientoCuenta({
          empresaId: coldexId,
          rol: RolCuenta.PROVEEDOR,
          tipo: TipoMovimientoCuenta.ABONO,
          origen: OrigenMovimientoCuenta.CARGO_MANUAL,
          lineaServicio: "TRAMITE",
          concepto: `${MARCA_EJEMPLO} Servicios aduaneros + quincenas y primas del mes`,
          valor: 4_000_000n,
          fecha: new Date(),
          usuarioId,
        });
        ok("Cargo manual para Coldex: 4.000.000 a su favor ('como 4 millones… varía', 72:50).");
        nota("Aparece en la sección Cuenta corriente de la ficha de Coldex.");
      }
    }
  }

  // ── Resumen ────────────────────────────────────────────────────────────────
  titulo("Resumen");
  const anchos = [0, 1, 2].map((i) => Math.max(...resumen.map((f) => (f[i] ?? "").length), 8));
  for (const fila of resumen) {
    console.log(
      `  ${fila[0]!.padEnd(anchos[0]!)}  ${fila[1]!.padEnd(anchos[1]!)}  ${fila[2]!.padEnd(anchos[2]!)}  ${fila[3]}`,
    );
  }

  const pendientesNit = await prisma.cliente.count({ where: { nit: { startsWith: "PENDIENTE-NIT-" } } });
  if (pendientesNit > 0) {
    console.log(
      `\n⚠ ${pendientesNit} empresa(s) quedaron con NIT PENDIENTE-NIT-*: completarlo desde la ficha (Editar) o con cliente_actualizar por MCP.`,
    );
  }
  console.log(
    "\nSin decidir (ver PENDIENTES-MARIA-CAMILA.md): valor de la comisión de Eltrans, NIT de Ascinter, si Sesderma va en el grupo Polired.",
  );
}

main()
  .catch((error) => {
    console.error("\n✗ Falló:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
