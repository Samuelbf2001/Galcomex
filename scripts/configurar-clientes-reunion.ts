/**
 * Configura en la BD las empresas de las reuniones de tarifas y cartera (julio)
 * y del 10-sep-2026 con las funciones que Camila describió, para que el sistema
 * se comporte con cada una como ella explicó — sin una sola rama nueva en el
 * código.
 *
 *   npx tsx scripts/configurar-clientes-reunion.ts             # empresas + funciones
 *   npx tsx scripts/configurar-clientes-reunion.ts --ejemplos  # además, un ejemplo por tema
 *
 * Idempotente: se puede correr las veces que haga falta.
 *
 * Cómo trata a cada empresa:
 *   · Busca por las palabras de `buscar` entre las empresas ya cargadas (en
 *     producción Camila las cargó con sus NIT reales: LITOPLAS SA, CW ASIA SAS,
 *     POLYREC S.A.S., POLYREC ZONA FRANCA S.A.S, SESDERMA COLOMBIA S.A.,
 *     LTRANS SAS, AGENCIA DE ADUANAS COLDEX…). NUNCA cambia NIT ni `tipo`.
 *   · Si no existe y es solo proveedor, la crea con NIT `PENDIENTE-NIT-<CLAVE>`
 *     para que quede a la vista que Camila debe completarlo. No se inventan NITs.
 *   · Si hay varias con ese nombre, la salta y avisa: mejor no adivinar.
 *   · Ignora las empresas de la demo (`DEMO ...`) y las de prueba.
 *   · OX S.A.S. no se configura: liquidaron la empresa (10-sep, min 00:42).
 *
 * Lo que NO decide este script (queda en PENDIENTES-MARIA-CAMILA.md):
 *   · El valor de la comisión por contenedor de Ltrans (no se dijo).
 *   · Si Sesderma pertenece al grupo Polyrec.
 *   · El NIT de Ascinter (hay dos candidatos) y de Almacarga.
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
import { marcarEventosTramite } from "../src/lib/eventos/service";
import { PLANTILLAS_TARIFARIO } from "../src/lib/tarifas/plantillas";
import { cambiarEstadoTarifario, crearTarifario, propuestaParaTramite } from "../src/lib/tarifas/service";
import { createTramite } from "../src/lib/tramites/service";

const MARCA_EJEMPLO = "[EJEMPLO REUNIÓN]";
const NOMBRE_GRUPO_POLYREC = "Grupo Polyrec";

// ─── Lo que se dijo en la reunión, empresa por empresa ────────────────────────

type Capacidad = { codigo: string; habilitado: boolean; config?: Record<string, unknown> };

type EmpresaReunion = {
  clave: string;
  /** Nombre con el que se crea si no existe (solo proveedores). */
  nombre: string;
  /** NIT real tomado de Siigo; si falta y hay que crearla, queda PENDIENTE-NIT-<CLAVE>. */
  nit?: string;
  /** Palabras que identifican a la empresa en los nombres ya cargados (minúsculas). */
  buscar: string[];
  /** Palabras que EXCLUYEN una coincidencia (p. ej. "zona franca" para Polyrec matriz). */
  excluir?: string[];
  esCliente: boolean;
  esProveedor: boolean;
  grupo?: "polyrec";
  /** Si no existe: crearla (proveedores sin ficha) o solo avisar (clientes: Camila los carga con NIT real). */
  crearSiFalta: boolean;
  capacidades: Capacidad[];
  /** Plantillas de tarifario que se publican (solo con `tarifario_propio`). */
  plantillas?: { codigo: string; desde: string; hasta: string }[];
  /** Qué dijo Camila; queda en la salida para poder contrastarlo. */
  fuente: string;
};

const EMPRESAS: EmpresaReunion[] = [
  {
    clave: "LITOPLAS",
    nombre: "LITOPLAS SA",
    buscar: ["litoplas"],
    esCliente: true,
    esProveedor: false,
    crearSiFalta: false,
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
    plantillas: [
      { codigo: "LITOPLAS_IMPO_2026", desde: "2026-02-02", hasta: "2027-01-31" },
      { codigo: "LITOPLAS_CLAS_2026", desde: "2026-02-02", hasta: "2027-01-31" },
      { codigo: "LITOPLAS_EXPO_2026", desde: "2026-02-02", hasta: "2027-01-31" },
    ],
    fuente:
      "Pide anticipos (jul 04:25). Tarifas propias, NO usa CIF (37:49). Clasificación aparte (14:48). Eventos: revisión 180k, entrega directa 200k, registro 433k (48:44). Moviaduanas + DO I######## (regla histórica). Plan Vallejo y sellos van como 'Otros servicios' (10-sep, 15:27).",
  },
  {
    clave: "CW_ASIA",
    nombre: "CW ASIA SAS",
    buscar: ["cw asia"],
    esCliente: true,
    esProveedor: false,
    crearSiFalta: false,
    capacidades: [
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "base_cif", habilitado: true },
      { codigo: "eventos_facturables", habilitado: true },
    ],
    plantillas: [{ codigo: "CW_ASIA_2026", desde: "2026-03-11", hasta: "2027-03-10" }],
    fuente:
      "Servicio logístico = CIF × 0,37 % con mínimos por tipo de carga (jul 75:20). Despacho parcial 50k (81:07). 'Facturas esperando': las tarifas son las de la propuesta (10-sep, 01:37).",
  },
  {
    clave: "EXPRESS_LOGISTICA",
    nombre: "EXPRESS LOGISTICA S.A.S",
    nit: "802011826-3",
    buscar: ["express logistica", "cw express", "cwexpress", "c.w. express"],
    esCliente: false,
    esProveedor: true,
    crearSiFalta: true,
    capacidades: [{ codigo: "anticipos_cliente", habilitado: false }],
    fuente: "Proveedor que solo le presta a Litoplas (jul 83:37; la transcripción dice 'CU Express'). En Siigo es EXPRESS LOGISTICA S.A.S: reempaque y embalaje en las facturas de Litoplas.",
  },
  {
    clave: "POLYREC",
    nombre: "POLYREC S.A.S.",
    buscar: ["polyrec", "polired", "polirred"],
    excluir: ["zona franca", " zf"],
    esCliente: true,
    esProveedor: false,
    grupo: "polyrec",
    crearSiFalta: false,
    capacidades: [{ codigo: "tarifario_propio", habilitado: true }],
    fuente:
      "Nacionalización: manda ORDEN DE COMPRA por el valor de la solicitud de fondos; la factura debe dar ese valor sin IVA y llevar el n° de OC en la descripción (10-sep, 84:30). Otra OC va a Cortes, la otra agencia. Falta su tarifario (Camila).",
  },
  {
    clave: "POLYREC_ZF",
    nombre: "POLYREC ZONA FRANCA S.A.S",
    buscar: ["polyrec zona franca", "polired zona franca", "polyrec zf", "polired zf"],
    esCliente: true,
    esProveedor: false,
    grupo: "polyrec",
    crearSiFalta: false,
    capacidades: [{ codigo: "tarifario_propio", habilitado: true }],
    plantillas: [{ codigo: "POLYREC_ZF_2026", desde: "2026-01-01", hasta: "2026-12-31" }],
    fuente:
      "Traslados: 'si es un contenedor son 300; si son dos o más, 250 cada contenedor' (10-sep, 83:31). Sin carpeta de documentos, solo facturas.",
  },
  {
    clave: "SESDERMA",
    nombre: "SESDERMA COLOMBIA S.A.",
    buscar: ["sesderma", "setderma"],
    esCliente: true,
    esProveedor: false,
    crearSiFalta: false,
    capacidades: [{ codigo: "tarifario_propio", habilitado: true }],
    fuente:
      "Cliente propio con DOs (jul, DO.BIGT26-0244). 'Genera más plata pero menos trámites' (10-sep, 02:24). Ascinter le factura transporte (60:05). ¿Grupo Polyrec? — no se dijo.",
  },
  {
    clave: "COLDEX",
    nombre: "AGENCIA DE ADUANAS COLDEX S.A.S NIVEL DOS",
    buscar: ["coldex"],
    esCliente: true,
    esProveedor: true,
    crearSiFalta: false,
    capacidades: [
      { codigo: "anticipos_cliente", habilitado: false },
      { codigo: "cargos_manuales_contraparte", habilitado: true },
    ],
    fuente:
      "Agencia de aduanas: proveedor, pero también se le hacen trámites (liberación de BLs). Mensualidad variable ~4M por servicios aduaneros + quincenas y primas (jul 68:45, 72:50). Se cruzan saldos.",
  },
  {
    clave: "LTRANS",
    nombre: "LTRANS SAS",
    buscar: ["ltrans", "eltrans", "el trans", "eltran"],
    esCliente: true,
    esProveedor: true,
    crearSiFalta: false,
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
      "Proveedor de Polyrec que le paga a Galcomex una comisión por contenedor (jul 84:02–89:27). Para Camila es 'un cliente que te va a pagar una comisión' (86:32).",
  },
  {
    clave: "ASCINTER",
    nombre: "ASCINTER",
    buscar: ["ascinter", "asinter", "acinter"],
    esCliente: true,
    esProveedor: true,
    crearSiFalta: true,
    capacidades: [{ codigo: "anticipos_cliente", habilitado: false }],
    fuente:
      "Proveedor (asesoría a nombre de Galcomex, transporte trasladable) y fue cliente el año pasado (jul 58:50). Pendiente: Guillermo decide si vuelve a serlo.",
  },
  {
    clave: "ALMACARGA",
    nombre: "ALMACENADORA DE CARGA \"ALMACARGA\" S.A.S",
    nit: "800154017-8",
    buscar: ["almacarga"],
    esCliente: false,
    esProveedor: true,
    crearSiFalta: true,
    capacidades: [{ codigo: "anticipos_cliente", habilitado: false }],
    fuente: "Proveedor de almacenaje, solo le presta a Litoplas; se paga en bloque a mitad de mes (jul 53:09).",
  },
];

/** Funciones que el grupo Polyrec enciende para todas sus empresas. */
const CAPACIDADES_GRUPO_POLYREC: Capacidad[] = [
  { codigo: "contenedores_obligatorio", habilitado: true },
  { codigo: "eventos_facturables", habilitado: true },
  { codigo: "orden_compra_en_revision", habilitado: true },
];

// ─── Salida ───────────────────────────────────────────────────────────────────

const ok = (t: string) => console.log(`    ✓ ${t}`);
const aviso = (t: string) => console.log(`    ⚠ ${t}`);
const nota = (t: string) => console.log(`      ${t}`);
const cop = (v: bigint) => `$ ${v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

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

function fecha(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function publicarPlantillas(empresa: EmpresaReunion, empresaId: string, usuarioId: string) {
  for (const p of empresa.plantillas ?? []) {
    const plantilla = PLANTILLAS_TARIFARIO.find((x) => x.codigo === p.codigo);
    if (!plantilla) {
      aviso(`Plantilla ${p.codigo} no existe en lib/tarifas/plantillas.ts`);
      continue;
    }
    const ya = await prisma.tarifario.findFirst({
      where: { empresaId, alcance: plantilla.alcance, estado: { in: ["VIGENTE", "BORRADOR"] } },
      select: { id: true, nombre: true, version: true, estado: true, notas: true },
    });
    if (ya) {
      nota(`Tarifario ${plantilla.alcance.toLowerCase()} ya existe: "${ya.nombre}" v${ya.version} (${ya.estado}); no se toca.`);
      continue;
    }
    // Sin marca "[PLANTILLA …]": la nota interna la pone `crearTarifario` por
    // defecto (Cargado desde la plantilla…) y nunca sale en el PDF (B4, 22-sep).
    const creado = await crearTarifario({
      empresaId,
      plantilla: p.codigo,
      vigenteDesde: fecha(p.desde),
      vigenteHasta: fecha(p.hasta),
      items: [],
      usuarioId,
    });
    await cambiarEstadoTarifario(creado.id, "VIGENTE", usuarioId);
    ok(`Tarifario "${plantilla.nombre}" v${creado.version} publicado con ${creado.items.length} ítems (${p.desde} → ${p.hasta})`);
  }
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
  const tipoOtro = await prisma.tipoTramite.findUnique({ where: { codigo: "OTRO" }, select: { codigo: true } });
  if (!tipoOtro) {
    console.error("✗ Falta el tipo de trámite OTRO: aplica la migración 20260914120000_tipo_otro_cortes_oc.");
    process.exitCode = 1;
    return;
  }

  // ── Grupo económico ────────────────────────────────────────────────────────
  const grupoViejo = await prisma.grupoEmpresa.findUnique({ where: { nombre: "Grupo Polired" } });
  const grupoPolyrec = grupoViejo
    ? await prisma.grupoEmpresa.update({ where: { id: grupoViejo.id }, data: { nombre: NOMBRE_GRUPO_POLYREC } })
    : await prisma.grupoEmpresa.upsert({
        where: { nombre: NOMBRE_GRUPO_POLYREC },
        update: {},
        create: { nombre: NOMBRE_GRUPO_POLYREC },
      });

  for (const cap of CAPACIDADES_GRUPO_POLYREC) {
    await prisma.grupoEmpresaCapacidad.upsert({
      where: { grupoId_codigo: { grupoId: grupoPolyrec.id, codigo: cap.codigo } },
      update: { habilitado: cap.habilitado },
      create: { grupoId: grupoPolyrec.id, codigo: cap.codigo, habilitado: cap.habilitado },
    });
  }
  ok(
    `${NOMBRE_GRUPO_POLYREC}: enciende ${CAPACIDADES_GRUPO_POLYREC.map((c) => c.codigo).join(", ")} para todas sus empresas.`,
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
          grupoEmpresaId: empresa.grupo === "polyrec" ? grupoPolyrec.id : undefined,
        },
      });
    } else if (empresa.crearSiFalta) {
      const nit = empresa.nit ?? `PENDIENTE-NIT-${empresa.clave}`;
      const creada = await prisma.cliente.create({
        data: {
          nombre: empresa.nombre,
          nit,
          tipo: "PROPIO",
          esCliente: empresa.esCliente,
          esProveedor: empresa.esProveedor,
          grupoEmpresaId: empresa.grupo === "polyrec" ? grupoPolyrec.id : null,
        },
      });
      id = creada.id;
      origen = empresa.nit
        ? `CREADA · NIT ${nit} (Siigo)`
        : `CREADA · NIT ${nit} — Camila debe completar el NIT real desde la ficha`;
    } else {
      aviso(`No existe ninguna empresa que coincida con "${empresa.buscar.join('" / "')}": Camila debe crearla con su NIT real.`);
      resumen.push([empresa.nombre, "NO EXISTE", "", ""]);
      continue;
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

    if (empresa.plantillas?.length && efectivas.includes("tarifario_propio")) {
      await publicarPlantillas(empresa, id, usuarioId);
    }

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
    await ejemplos(ids, usuarioId);
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
    "\nSin decidir (ver PENDIENTES-MARIA-CAMILA.md): tarifario de Polyrec S.A.S., valor de la comisión de Ltrans, NIT de Ascinter y Almacarga, si Sesderma va en el grupo Polyrec.",
  );
}

// ─── Un ejemplo por tema, marcado [EJEMPLO REUNIÓN] ────────────────────────────

async function ejemplos(ids: Map<string, string>, usuarioId: string) {
  titulo("Ejemplos (uno por tema, todos marcados [EJEMPLO REUNIÓN])");

  const litoplasId = ids.get("LITOPLAS");
  const polyrecId = ids.get("POLYREC");
  const polyrecZfId = ids.get("POLYREC_ZF");
  const coldexId = ids.get("COLDEX");

  // 1. Clasificación arancelaria con consecutivo propio (Litoplas).
  if (litoplasId) {
    const yaExiste = await prisma.tramiteDO.findFirst({
      where: { clienteId: litoplasId, tipoTramiteCodigo: "CLASIFICACION", comentarios: { contains: MARCA_EJEMPLO } },
      select: { consecutivo: true },
    });
    if (yaExiste) {
      ok(`1. Clasificación de ejemplo ya existe: ${yaExiste.consecutivo}`);
    } else {
      const clas = await createTramite({
        ciudad: Ciudad.BAQ,
        clienteId: litoplasId,
        tipoTramiteCodigo: "CLASIFICACION",
        referenciaExterna: "2140",
        comentarios: `${MARCA_EJEMPLO} Informe de clasificación 2140 del 16/07/2026 · Generador de aire caliente a gas · subpartida 7322.90.00.00 · tarifa 380.000 + IVA`,
        creadoPorId: usuarioId,
      });
      ok(`1. Clasificación arancelaria para Litoplas: ${clas.consecutivo} (informe externo 2140)`);
    }

    // 2. Otros servicios: firma de Plan Vallejo (consecutivo OTR26-XXXX).
    const yaOtro = await prisma.tramiteDO.findFirst({
      where: { clienteId: litoplasId, tipoTramiteCodigo: "OTRO", comentarios: { contains: MARCA_EJEMPLO } },
      select: { consecutivo: true },
    });
    if (yaOtro) {
      ok(`2. Servicio 'otro' de ejemplo ya existe: ${yaOtro.consecutivo}`);
    } else {
      const otro = await createTramite({
        ciudad: Ciudad.BAQ,
        clienteId: litoplasId,
        tipoTramiteCodigo: "OTRO",
        referenciaExterna: "Firma Plan Vallejo — programa de materias primas",
        comentarios: `${MARCA_EJEMPLO} Servicio sin DO: firma del Plan Vallejo de Litoplas. Se cobra con el producto Siigo 014 PROGRAMA PLAN VALLEJO, factura aparte, línea de cartera OTROS (10-sep, min 15:27).`,
        creadoPorId: usuarioId,
      });
      ok(`2. Otros servicios para Litoplas: ${otro.consecutivo} (Plan Vallejo) — sin agencia, sin ETA, sin checklist`);
    }

    // 3. Eventos + base de cálculo sobre un DO de importación DE EJEMPLO de
    //    Litoplas. Nunca sobre uno real: si no existe, se crea (Moviaduanas y
    //    DO de agencia con el formato que exige la regla fija).
    let doLitoplas = await prisma.tramiteDO.findFirst({
      where: { clienteId: litoplasId, tipoTramiteCodigo: "IMPORTACION", comentarios: { contains: MARCA_EJEMPLO } },
      select: { id: true, consecutivo: true },
    });
    if (!doLitoplas) {
      const creado = await createTramite({
        ciudad: Ciudad.BAQ,
        clienteId: litoplasId,
        agenciaAduanas: "MOVIADUANAS",
        doAgencia: "I00000001",
        proveedorCliente: "Proveedor de ejemplo",
        comentarios: `${MARCA_EJEMPLO} DO de importación de ejemplo para la simulación: 3 declaraciones, contenedor de 20′, revisión en despacho y registro elaborado.`,
        creadoPorId: usuarioId,
      });
      doLitoplas = { id: creado.id, consecutivo: creado.consecutivo };
    }
    {
      await prisma.tramiteDO.update({
        where: { id: doLitoplas.id },
        data: { numDeclaraciones: 3, tipoCarga: "CONTENEDOR_20", numContenedores: 1, numDocumentos: 4 },
      });
      await marcarEventosTramite({
        tramiteId: doLitoplas.id,
        usuarioId,
        eventos: [
          { codigo: "REVISION_DESPACHO", cantidad: 1, observacion: MARCA_EJEMPLO },
          { codigo: "ELABORACION_REGISTRO", cantidad: 1, observacion: MARCA_EJEMPLO },
        ],
      });
      const propuesta = await propuestaParaTramite(doLitoplas.id);
      ok(`3. Eventos en ${doLitoplas.consecutivo}: revisión en despacho + registro elaborado; 3 declaraciones, contenedor 20′`);
      for (const l of propuesta.resultado?.lineas ?? []) {
        nota(`${l.nombrePublico.padEnd(58)} ${cop(l.valor).padStart(14)}  ${l.origen === "EVENTO" ? "(evento)" : ""}`);
      }
      if (propuesta.resultado) nota(`${"Total conceptos".padEnd(58)} ${cop(propuesta.resultado.total).padStart(14)}`);
      if (propuesta.motivo) aviso(propuesta.motivo);
    }
  }

  // 4. Polyrec ZF: traslado de 2 contenedores → tarifa por tramos (250.000 × 2).
  if (polyrecZfId) {
    let traslado = await prisma.tramiteDO.findFirst({
      where: { clienteId: polyrecZfId, comentarios: { contains: MARCA_EJEMPLO } },
      select: { id: true, consecutivo: true },
    });
    if (!traslado) {
      const creado = await createTramite({
        ciudad: Ciudad.BAQ,
        clienteId: polyrecZfId,
        agenciaAduanas: "COLDEX",
        comentarios: `${MARCA_EJEMPLO} Traslado de 2 contenedores en zona franca: 1 contenedor 300.000; 2 o más 250.000 c/u (10-sep, min 83:31).`,
        creadoPorId: usuarioId,
      });
      traslado = { id: creado.id, consecutivo: creado.consecutivo };
    }
    await prisma.tramiteDO.update({ where: { id: traslado.id }, data: { numContenedores: 2 } });
    const propuesta = await propuestaParaTramite(traslado.id);
    ok(`4. Polyrec ZF ${traslado.consecutivo}: 2 contenedores`);
    for (const l of propuesta.resultado?.lineas ?? []) nota(`${l.nombrePublico}: ${cop(l.valor)} — ${l.detalle}`);
    if (propuesta.motivo) aviso(propuesta.motivo);
  }

  // 5. Polyrec nacionalización: orden de compra en el DO (número + valor sin IVA).
  if (polyrecId) {
    let oc = await prisma.tramiteDO.findFirst({
      where: { clienteId: polyrecId, comentarios: { contains: MARCA_EJEMPLO } },
      select: { id: true, consecutivo: true },
    });
    if (!oc) {
      const creado = await createTramite({
        ciudad: Ciudad.BAQ,
        clienteId: polyrecId,
        agenciaAduanas: "CORTES",
        comentarios: `${MARCA_EJEMPLO} Nacionalización con orden de compra: Polyrec devuelve una OC por el valor de la solicitud de fondos; la factura debe dar ese valor sin IVA y llevar el n° de OC (10-sep, min 84:30).`,
        creadoPorId: usuarioId,
      });
      oc = { id: creado.id, consecutivo: creado.consecutivo };
    }
    await prisma.tramiteDO.update({
      where: { id: oc.id },
      data: { ordenCompraNumero: "OC-EJEMPLO-2026-0154", ordenCompraValor: 4_500_000n, numContenedores: 1 },
    });
    ok(`5. Polyrec ${oc.consecutivo}: agencia Cortes, OC-EJEMPLO-2026-0154 por ${cop(4_500_000n)} sin IVA — al generar el borrador la cabecera lleva "ORDEN DE COMPRA N° …" y la revisión contrasta el valor`);
  }

  // 6. Coldex: cargo manual a favor del proveedor (mensualidad variable).
  if (coldexId) {
    const yaExiste = await prisma.movimientoCuenta.findFirst({
      where: { empresaId: coldexId, concepto: { contains: MARCA_EJEMPLO } },
      select: { id: true },
    });
    if (yaExiste) {
      ok("6. Cargo manual de ejemplo para Coldex ya existe.");
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
      ok("6. Cargo manual para Coldex: 4.000.000 a su favor ('como 4 millones… varía', jul 72:50). Se ve en Cuenta corriente y se puede cruzar con lo que Coldex deba.");
    }
  }
}

main()
  .catch((error) => {
    console.error("\n✗ Falló:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
