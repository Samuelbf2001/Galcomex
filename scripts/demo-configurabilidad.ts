/**
 * Demo de configurabilidad — Galcomex
 *
 * Demuestra, contra la BD real, la tesis del PLAN-CONFIGURABILIDAD:
 * **dar de alta una empresa con reglas propias es cargar configuración, no
 * escribir código.**
 *
 *   npx tsx scripts/demo-configurabilidad.ts            # siembra y demuestra
 *   npx tsx scripts/demo-configurabilidad.ts --limpiar  # borra los datos DEMO
 *
 * Todo lo que crea lleva el prefijo "DEMO CFG " en el nombre y "DEMO-CFG-" en el
 * NIT — deliberadamente específico para no pisar otros datos de prueba que ya
 * existan en la BD con prefijo "DEMO-".
 *
 * Requiere las migraciones aplicadas:
 *   docker compose up -d postgres && npx prisma migrate deploy && npm run db:seed
 */

import "dotenv/config";

import {
  AgenciaAduanas,
  Ciudad,
  EstadoTramite,
  OrigenMovimientoCuenta,
  Rol,
  RolCuenta,
  TipoMovimientoCuenta,
} from "@prisma/client";

import { capacidadesActivas, configDe, tiene } from "../src/lib/capacidades/resolver";
import { capacidadesDeEmpresa, setCapacidadesEmpresa } from "../src/lib/capacidades/service";
import { calcularCruceFacturas } from "../src/lib/borradores/cruce-facturas";
import { describirNeto } from "../src/lib/cuenta-corriente/calculo";
import {
  getCuentaCorriente,
  registrarMovimientoCuenta,
} from "../src/lib/cuenta-corriente/service";
import { prisma } from "../src/lib/db/prisma";
import { crearFacturaProveedor } from "../src/lib/facturas-proveedor/service";
import { createTramite, transitionTramite } from "../src/lib/tramites/service";
import type { ConfigReglaAgencia } from "../src/lib/tramites/reglas";

const PREFIJO_NOMBRE = "DEMO CFG ";
const PREFIJO_NIT = "DEMO-CFG-";
const ANIO = 2091; // año "de laboratorio": no colisiona con consecutivos reales

// ─── Presentación ─────────────────────────────────────────────────────────────

const linea = (n = 78) => "─".repeat(n);

function titulo(texto: string) {
  console.log(`\n${linea()}\n${texto}\n${linea()}`);
}

function paso(n: number, texto: string) {
  console.log(`\n[${n}] ${texto}`);
}

function ok(texto: string) {
  console.log(`    ✓ ${texto}`);
}

function nota(texto: string) {
  console.log(`      ${texto}`);
}

function tabla(cabeceras: string[], filas: string[][]) {
  const anchos = cabeceras.map((c, i) =>
    Math.max(c.length, ...filas.map((f) => (f[i] ?? "").length)),
  );
  const fmt = (celdas: string[]) =>
    celdas.map((c, i) => (c ?? "").padEnd(anchos[i]!)).join("  ");

  console.log(`    ${fmt(cabeceras)}`);
  console.log(`    ${anchos.map((a) => "─".repeat(a)).join("  ")}`);
  for (const fila of filas) {
    console.log(`    ${fmt(fila)}`);
  }
}

// ─── Configuración de la demo (sale de la reunión, no del código) ─────────────

type EmpresaDemo = {
  clave: string;
  nombre: string;
  esCliente: boolean;
  esProveedor: boolean;
  grupo?: string;
  capacidades: { codigo: string; habilitado: boolean; config?: Record<string, unknown> }[];
};

const EMPRESAS: EmpresaDemo[] = [
  {
    clave: "litoplas",
    nombre: `${PREFIJO_NOMBRE}LITOPLAS SA`,
    esCliente: true,
    esProveedor: false,
    capacidades: [
      { codigo: "anticipos_cliente", habilitado: true },
      { codigo: "tarifario_propio", habilitado: true },
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
  },
  {
    clave: "cw",
    nombre: `${PREFIJO_NOMBRE}CW EXPRESS`,
    esCliente: true,
    esProveedor: true,
    capacidades: [
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "base_cif", habilitado: true },
      { codigo: "eventos_facturables", habilitado: true },
    ],
  },
  {
    clave: "polired",
    nombre: `${PREFIJO_NOMBRE}POLIRED SAS`,
    esCliente: true,
    esProveedor: false,
    grupo: "polired",
    capacidades: [{ codigo: "tarifario_propio", habilitado: true }],
  },
  {
    clave: "polired-zf",
    nombre: `${PREFIJO_NOMBRE}POLIRED ZONA FRANCA`,
    esCliente: true,
    esProveedor: false,
    grupo: "polired",
    // No declara nada propio: todo lo hereda del grupo económico.
    capacidades: [],
  },
  {
    clave: "coldex",
    nombre: `${PREFIJO_NOMBRE}COLDEX`,
    esCliente: false,
    esProveedor: true,
    capacidades: [
      { codigo: "anticipos_cliente", habilitado: false },
      { codigo: "cargos_manuales_contraparte", habilitado: true },
    ],
  },
  {
    clave: "eltrans",
    nombre: `${PREFIJO_NOMBRE}ELTRANS`,
    esCliente: false,
    esProveedor: true,
    capacidades: [
      { codigo: "anticipos_cliente", habilitado: false },
      { codigo: "contenedores_obligatorio", habilitado: true },
      {
        codigo: "comision_por_evento",
        habilitado: true,
        config: { unidad: "CONTENEDOR", valor: "45000" },
      },
    ],
  },
  {
    clave: "ascinter",
    nombre: `${PREFIJO_NOMBRE}ASCINTER`,
    esCliente: true,
    esProveedor: true,
    capacidades: [{ codigo: "anticipos_cliente", habilitado: false }],
  },
];

/** El grupo económico enciende la función para todas sus empresas de una vez. */
const CAPACIDADES_GRUPO_POLIRED = [
  { codigo: "contenedores_obligatorio", habilitado: true },
  { codigo: "eventos_facturables", habilitado: true },
];

// ─── Limpieza ─────────────────────────────────────────────────────────────────

async function limpiar(): Promise<void> {
  const empresas = await prisma.cliente.findMany({
    where: { nit: { startsWith: PREFIJO_NIT } },
    select: { id: true },
  });
  const empresaIds = empresas.map((e) => e.id);

  const tramites = await prisma.tramiteDO.findMany({
    where: { clienteId: { in: empresaIds } },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);

  if (empresaIds.length === 0 && tramiteIds.length === 0) {
    console.log("✓ Limpieza: no había datos de esta demo.");
    return;
  }

  const borradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = borradores.map((b) => b.id);

  const pagos = await prisma.pagoTramite.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const pagoIds = pagos.map((p) => p.id);

  // Los AuditLog de la demo no siempre se pueden encontrar por entidadId (el de
  // capacidades usa la clave compuesta `empresaId:codigo`), así que se borran
  // también por el usuario que los escribió.
  const usuariosDemo = await prisma.user.findMany({
    where: { email: { startsWith: "demo-config@" } },
    select: { id: true },
  });
  const usuarioIds = usuariosDemo.map((u) => u.id);

  // Orden de borrado dictado por las FK, de las hojas hacia la raíz.
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: empresaIds } },
        { usuarioId: { in: usuarioIds } },
      ],
    },
  });
  await prisma.movimientoCuenta.deleteMany({ where: { empresaId: { in: empresaIds } } });
  await prisma.pagoFactura.deleteMany({ where: { factura: { clienteId: { in: empresaIds } } } });
  await prisma.factura.deleteMany({ where: { clienteId: { in: empresaIds } } });
  await prisma.lineaRevisionFactura.deleteMany({
    where: { linea: { borradorId: { in: borradorIds } } },
  });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.pagoTramiteFactura.deleteMany({ where: { pagoId: { in: pagoIds } } });
  await prisma.pagoTramiteBeneficiario.deleteMany({ where: { pagoId: { in: pagoIds } } });
  await prisma.pagoTramite.deleteMany({ where: { id: { in: pagoIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.beneficiario.deleteMany({ where: { nit: { startsWith: PREFIJO_NIT } } });
  await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.anticipo.deleteMany({ where: { clienteId: { in: empresaIds } } });
  await prisma.documento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.pseSolicitud.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifaCliente.deleteMany({ where: { clienteId: { in: empresaIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: empresaIds } } });
  await prisma.grupoEmpresa.deleteMany({ where: { nombre: { startsWith: PREFIJO_NOMBRE } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "demo-config@" } } });

  console.log(
    `✓ Limpieza: ${empresaIds.length} empresas y ${tramiteIds.length} trámites DEMO eliminados.`,
  );
}

// ─── Preparación ──────────────────────────────────────────────────────────────

async function verificarCatalogo(): Promise<boolean> {
  const [capacidades, tipos] = await Promise.all([
    prisma.capacidad.count(),
    prisma.tipoTramite.count(),
  ]);

  if (capacidades === 0 || tipos === 0) {
    console.error(
      [
        "✗ Falta el catálogo en la BD (capacidades: " + capacidades + ", tipos de trámite: " + tipos + ").",
        "",
        "  Aplica las migraciones y el seed antes de correr la demo:",
        "    docker compose up -d postgres",
        "    npx prisma migrate deploy",
        "    npm run db:seed",
      ].join("\n"),
    );
    return false;
  }

  ok(`Catálogo en BD: ${capacidades} capacidades, ${tipos} tipos de trámite.`);
  return true;
}

async function usuarioDemo(): Promise<string> {
  const existente = await prisma.user.findFirst({
    where: { email: "demo-config@galcomex.com" },
    select: { id: true },
  });
  if (existente) return existente.id;

  const creado = await prisma.user.create({
    data: {
      email: "demo-config@galcomex.com",
      name: "Demo Configurabilidad",
      emailVerified: true,
      rol: Rol.ADMIN,
    },
  });
  return creado.id;
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--limpiar")) {
    await limpiar();
    return;
  }

  titulo("DEMO — Un sistema, muchas empresas");
  console.log(
    "Siete empresas con reglas distintas, cero ramas en el código.\nCada diferencia de abajo es una fila de configuración.",
  );

  paso(0, "Verificando catálogo");
  if (!(await verificarCatalogo())) return;

  await limpiar();
  const usuarioId = await usuarioDemo();

  // ── 1. Empresas y grupo económico ──────────────────────────────────────────
  paso(1, "Creando empresas y grupo económico");

  const grupo = await prisma.grupoEmpresa.create({
    data: { nombre: `${PREFIJO_NOMBRE}Grupo Polired` },
  });
  ok(`Grupo económico "${grupo.nombre}" creado.`);

  for (const capacidad of CAPACIDADES_GRUPO_POLIRED) {
    await prisma.grupoEmpresaCapacidad.create({
      data: { grupoId: grupo.id, codigo: capacidad.codigo, habilitado: capacidad.habilitado },
    });
  }
  nota(`El grupo enciende: ${CAPACIDADES_GRUPO_POLIRED.map((c) => c.codigo).join(", ")}`);

  const ids = new Map<string, string>();

  for (const [indice, empresa] of EMPRESAS.entries()) {
    const creada = await prisma.cliente.create({
      data: {
        nombre: empresa.nombre,
        nit: `${PREFIJO_NIT}${String(indice + 1).padStart(3, "0")}`,
        esCliente: empresa.esCliente,
        esProveedor: empresa.esProveedor,
        grupoEmpresaId: empresa.grupo === "polired" ? grupo.id : null,
      },
    });
    ids.set(empresa.clave, creada.id);

    if (empresa.capacidades.length > 0) {
      await setCapacidadesEmpresa({
        empresaId: creada.id,
        cambios: empresa.capacidades.map((c) => ({
          codigo: c.codigo as never,
          habilitado: c.habilitado,
          config: c.config ?? undefined,
        })),
        usuarioId,
      });
    }
  }
  ok(`${EMPRESAS.length} empresas creadas con su configuración.`);

  // ── 2. Matriz resuelta ─────────────────────────────────────────────────────
  paso(2, "Matriz de funciones efectiva (lo que resuelve el sistema)");

  const filas: string[][] = [];
  for (const empresa of EMPRESAS) {
    const capacidades = await capacidadesDeEmpresa(ids.get(empresa.clave)!);
    filas.push([
      empresa.nombre.replace(PREFIJO_NOMBRE, ""),
      [empresa.esCliente ? "cliente" : "", empresa.esProveedor ? "proveedor" : ""]
        .filter(Boolean)
        .join("+"),
      String(capacidadesActivas(capacidades).length),
      capacidadesActivas(capacidades).join(", ") || "—",
    ]);
  }
  tabla(["EMPRESA", "ROL", "N°", "FUNCIONES ACTIVAS"], filas);

  // ── 3. Cascada del grupo ───────────────────────────────────────────────────
  paso(3, "Cascada: qué hereda una empresa que no declara nada");

  const zf = await capacidadesDeEmpresa(ids.get("polired-zf")!);
  const contenedores = zf.get("contenedores_obligatorio");
  ok(
    `POLIRED ZONA FRANCA no declaró ninguna función propia y tiene ` +
      `"contenedores_obligatorio" = ${contenedores?.habilitado} (origen: ${contenedores?.origenHabilitado}).`,
  );
  nota("Encender la función en el grupo la encendió en todas sus empresas.");

  // ── 4. Tipos de trámite con consecutivo propio ─────────────────────────────
  paso(4, "Tipos de trámite: consecutivos independientes");

  const litoplasId = ids.get("litoplas")!;

  const importacion = await createTramite({
    ciudad: Ciudad.BAQ,
    anio: ANIO,
    clienteId: litoplasId,
    agenciaAduanas: AgenciaAduanas.MOVIADUANAS,
    doAgencia: "I12345678",
    creadoPorId: usuarioId,
    comentarios: "DEMO importación",
  });
  ok(`Trámite de importación: ${importacion.consecutivo}`);

  const clasificacion = await createTramite({
    ciudad: Ciudad.BAQ,
    anio: ANIO,
    clienteId: litoplasId,
    tipoTramiteCodigo: "CLASIFICACION",
    referenciaExterna: "2140",
    creadoPorId: usuarioId,
    comentarios: "DEMO clasificación",
  });
  ok(`Clasificación arancelaria: ${clasificacion.consecutivo} (informe externo 2140)`);
  nota(
    `Sin agencia de aduanas (${clasificacion.agenciaAduanas ?? "null"}), sin ETA y con ` +
      `contador aparte: no consumió consecutivo de importación.`,
  );

  // ── 5. La capacidad como puerta ────────────────────────────────────────────
  paso(5, "La misma función, apagada para otra empresa");

  try {
    await createTramite({
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      clienteId: ids.get("cw")!,
      tipoTramiteCodigo: "CLASIFICACION",
      creadoPorId: usuarioId,
    });
    console.log("    ✗ ERROR: debió rechazarse, CW EXPRESS no tiene la capacidad.");
  } catch (error) {
    ok(`CW EXPRESS rechazado: "${(error as Error).message}"`);
    nota("Para habilitarlo basta un clic en la ficha de la empresa. Cero despliegues.");
  }

  // ── 6. La regla de Litoplas, ahora como dato ───────────────────────────────
  paso(6, "La regla de agencia dejó de ser un if con el nombre de la empresa");

  const capsLitoplas = await capacidadesDeEmpresa(litoplasId);
  const config = configDe<ConfigReglaAgencia>(capsLitoplas, "regla_agencia_fija");
  ok(`Config de la regla: ${JSON.stringify(config)}`);

  const malo = await createTramite({
    ciudad: Ciudad.CTG,
    anio: ANIO,
    clienteId: litoplasId,
    agenciaAduanas: AgenciaAduanas.COLDEX,
    doAgencia: "X999",
    creadoPorId: usuarioId,
    comentarios: "DEMO regla agencia",
  });
  await transitionTramite(malo.id, EstadoTramite.APERTURA, usuarioId, true);
  const rechazo = await transitionTramite(
    malo.id,
    EstadoTramite.EN_TRAMITE,
    usuarioId,
    true,
  );
  ok(
    rechazo.ok
      ? "✗ ERROR: la transición debió bloquearse"
      : `Transición bloqueada: "${rechazo.message}"`,
  );

  await transitionTramite(importacion.id, EstadoTramite.APERTURA, usuarioId, true);
  const aceptado = await transitionTramite(
    importacion.id,
    EstadoTramite.EN_TRAMITE,
    usuarioId,
    true,
  );
  ok(
    aceptado.ok
      ? `${importacion.consecutivo} avanzó a EN_TRAMITE (Moviaduanas + I12345678).`
      : `✗ ERROR: debió pasar — ${aceptado.message}`,
  );

  // ── 7. Facturas que no se le cobran al cliente ─────────────────────────────
  paso(7, "Factura de proveedor que el cliente no debe ver");

  const transporte = await crearFacturaProveedor({
    tramiteId: importacion.id,
    proveedorNombre: `${PREFIJO_NOMBRE}ASCINTER`,
    numFactura: "DEMO-TRANSP-001",
    valor: 1_200_000n,
    fecha: new Date(),
    concepto: "Transporte",
    repercutible: true,
    subidaPorId: usuarioId,
  });
  ok(`${transporte.numFactura} · transporte · repercutible = ${transporte.repercutible}`);

  const asesoria = await crearFacturaProveedor({
    tramiteId: importacion.id,
    proveedorNombre: `${PREFIJO_NOMBRE}ASCINTER`,
    numFactura: "DEMO-ASESORIA-001",
    valor: 250_000n,
    fecha: new Date(),
    concepto: "Asesoría",
    repercutible: false,
    subidaPorId: usuarioId,
  });
  ok(`${asesoria.numFactura} · asesoría · repercutible = ${asesoria.repercutible}`);

  const cruce = calcularCruceFacturas(
    [transporte, asesoria],
    [
      { facturaId: transporte.id, pago: { valor: 1_200_000n } },
      { facturaId: asesoria.id, pago: { valor: 250_000n } },
    ],
    [{ facturaId: transporte.id, linea: { valor: 1_200_000n } }],
  );

  tabla(
    ["FACTURA", "PAGADO", "FACTURADO", "DIFERENCIA", "¿ALERTA?"],
    cruce.map((f) => [
      f.numFactura,
      f.montoPagado,
      f.montoFacturado,
      f.diferencia,
      f.esDesviacion
        ? "SÍ"
        : f.repercutible
          ? "no — cuadra"
          : "no — no se le cobra al cliente",
    ]),
  );
  nota("La asesoría se pagó pero no se trasladó, y el revisor no ve una falsa alarma.");

  // ── 8. Comisión configurada ────────────────────────────────────────────────
  paso(8, "Comisión que un proveedor le paga a Galcomex");

  const capsEltrans = await capacidadesDeEmpresa(ids.get("eltrans")!);
  const comision = configDe<{ unidad?: unknown; valor?: unknown }>(
    capsEltrans,
    "comision_por_evento",
  );
  ok(
    `ELTRANS: comisión ${comision?.valor} COP por ${comision?.unidad}. ` +
      `Anticipos = ${tiene(capsEltrans, "anticipos_cliente")}.`,
  );

  // ── 9. Cuenta corriente de una contraparte que es las dos cosas ────────────
  paso(9, "Cuenta corriente: cliente y proveedor en un solo saldo");

  const ascinterId = ids.get("ascinter")!;

  // El puente hacia el lado proveedor: la ficha de pago apunta a la empresa.
  const beneficiarioAscinter = await prisma.beneficiario.create({
    data: {
      nombre: `${PREFIJO_NOMBRE}ASCINTER`,
      nit: `${PREFIJO_NIT}007`,
      empresaId: ascinterId,
    },
  });

  await prisma.facturaProveedor.updateMany({
    where: { id: { in: [transporte.id, asesoria.id] } },
    data: { beneficiarioId: beneficiarioAscinter.id },
  });

  const cuentaAscinter = await getCuentaCorriente(ascinterId);
  tabla(
    ["EMPRESA", "NOS DEBE", "LE DEBEMOS", "SALDO CRUZADO"],
    [
      [
        "ASCINTER",
        cuentaAscinter.totalACargo.toString(),
        cuentaAscinter.totalAFavor.toString(),
        cuentaAscinter.neto.toString(),
      ],
    ],
  );
  ok(describirNeto(cuentaAscinter.neto, "ASCINTER"));
  nota(
    "Las dos facturas (transporte y asesoría) suman a su favor aunque solo una " +
      "se le traslade al cliente: al proveedor se le debe igual.",
  );

  // Coldex: la mensualidad variable que no nace de ningún trámite.
  await registrarMovimientoCuenta({
    empresaId: ids.get("coldex")!,
    rol: RolCuenta.PROVEEDOR,
    tipo: TipoMovimientoCuenta.ABONO,
    origen: OrigenMovimientoCuenta.CARGO_MANUAL,
    lineaServicio: "TRAMITE",
    concepto: "Servicios aduaneros + quincenas del mes",
    valor: 4_000_000n,
    fecha: new Date(),
    usuarioId,
  });

  const cuentaColdex = await getCuentaCorriente(ids.get("coldex")!);
  ok(
    `COLDEX: cargo manual de 4.000.000 registrado. Saldo cruzado ${cuentaColdex.neto}. ` +
      describirNeto(cuentaColdex.neto, "COLDEX"),
  );

  // Eltrans: la comisión por contenedor, del lado contrario.
  await registrarMovimientoCuenta({
    empresaId: ids.get("eltrans")!,
    rol: RolCuenta.PROVEEDOR,
    tipo: TipoMovimientoCuenta.CARGO,
    origen: OrigenMovimientoCuenta.COMISION,
    lineaServicio: "COMISION",
    concepto: "Comisión por 3 contenedores de Polired",
    valor: 135_000n,
    fecha: new Date(),
    tramiteId: importacion.id,
    usuarioId,
  });

  const cuentaEltrans = await getCuentaCorriente(ids.get("eltrans")!);
  ok(
    `ELTRANS: comisión de 135.000 a favor de Galcomex. ` +
      describirNeto(cuentaEltrans.neto, "ELTRANS"),
  );
  nota("Un solo libro sirve para la cartera de clientes y la de proveedores.");

  // ── Cierre ─────────────────────────────────────────────────────────────────
  titulo("RESUMEN");
  console.log(
    [
      "7 empresas · 2 tipos de trámite · 1 grupo económico · 0 ramas nuevas en el código.",
      "",
      "  · Litoplas exige Moviaduanas porque su ficha lo dice, no porque se llame Litoplas.",
      "  · La clasificación lleva consecutivo propio porque su tipo lo declara.",
      "  · La asesoría no llega al cliente porque la factura lo dice.",
      "",
      `Para dar de alta la octava empresa: crear la ficha y marcar sus funciones.`,
      "",
      "Limpieza:  npx tsx scripts/demo-configurabilidad.ts --limpiar",
    ].join("\n"),
  );
}

main()
  .catch((error) => {
    console.error("\n✗ La demo falló:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
