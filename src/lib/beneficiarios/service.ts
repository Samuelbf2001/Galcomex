import { Prisma, type Beneficiario } from "@prisma/client";

import {
  BeneficiarioExisteError,
  CxpError,
  FacturaDuplicadaError,
  NitDvInvalidoError,
  NitNoCoincideEmpresaError,
  PosibleBeneficiarioDuplicadoError,
} from "@/lib/cxp/errores";
import {
  candidatosNitParecido,
  claveProveedorDeFicha,
  doCorto,
  dvNit,
  nitBaseDe,
  numeroFacturaVisible,
} from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";

export type { Beneficiario };

type Tx = Prisma.TransactionClient;

/**
 * Una empresa marcada como proveedor necesita su ficha de pago (`Beneficiario`)
 * enlazada por `empresaId`: sin ese puente no aparece en el libro de pagos, en
 * las facturas de proveedor ni en la punta proveedor de la cuenta corriente.
 * Idempotente: reutiliza la ficha ya enlazada, enlaza una existente con el
 * mismo NIT (CxP v2: mismo NIT base, con o sin DV) o crea una nueva. Devuelve
 * la ficha resultante.
 */
export async function asegurarBeneficiarioDeEmpresa(
  tx: Prisma.TransactionClient,
  empresa: { id: string; nombre: string; nit: string },
): Promise<Beneficiario> {
  const enlazado = await tx.beneficiario.findFirst({ where: { empresaId: empresa.id } });
  if (enlazado) return enlazado;

  const nit = empresa.nit.trim();
  const base = nitBaseDe(nit);
  const porNit = nit
    ? await tx.beneficiario.findFirst({
        where: base !== null ? { nitBase: base, empresaId: null } : { nit, empresaId: null },
        orderBy: { createdAt: "asc" },
      })
    : null;
  if (porNit) {
    return tx.beneficiario.update({ where: { id: porNit.id }, data: { empresaId: empresa.id } });
  }

  return tx.beneficiario.create({
    data: { nombre: empresa.nombre.trim(), nit: nit || null, empresaId: empresa.id },
  });
}

/**
 * Serializa un snapshot a JSON apto para columnas Json de Prisma, convirtiendo
 * BigInt → string. Mismo replacer usado en el resto de services.
 */
function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

export type CrearBeneficiarioInput = {
  nombre: string;
  /** NIT sin DV (o con el DV pegado con guion, "800154017-8"). Cédulas y extranjeros: sin DV. */
  nit?: string | null;
  /** Dígito de verificación (0–9). Si viene y no cuadra con el algoritmo DIAN → `NIT_DV_INVALIDO`. */
  dv?: number | null;
  banco?: string | null;
  numCuenta?: string | null;
  /** Empresa a la que pertenece la ficha (M5). Su NIT base debe ser el de la empresa. */
  empresaId?: string | null;
  /** Nombre en la línea de terceros de la factura de venta ("ALMACARGA"). */
  nombreCorto?: string | null;
  /** "Numerar sus facturas como FE 11298". */
  numFacturaConEspacio?: boolean;
  /** Reenvío tras `POSIBLE_BENEFICIARIO_DUPLICADO`. */
  confirmarOtraFicha?: boolean;
};

export type OpcionesFicha = {
  /**
   * Otra ficha con el MISMO NIT base (otra cuenta bancaria del mismo proveedor,
   * PRD §10). Solo ADMIN: la ruta lo calcula con el rol de la sesión.
   */
  permitirMismoNit?: boolean;
};

export class BeneficiarioNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Beneficiario ${id} no encontrado`);
    this.name = "BeneficiarioNoEncontradoError";
  }
}

/** `empresaId` de una empresa que no existe (al crear o editar una ficha). */
export class EmpresaNoEncontradaParaBeneficiarioError extends Error {
  public readonly status = 404;
  constructor(empresaId: string) {
    super(`Empresa ${empresaId} no encontrada`);
    this.name = "EmpresaNoEncontradaParaBeneficiarioError";
  }
}

/** La empresa de «Enlazar ficha de pago» no existe. */
export class EmpresaNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(empresaId: string) {
    super(`Empresa ${empresaId} no encontrada`);
    this.name = "EmpresaNoEncontradaError";
  }
}

async function validarEmpresaParaEnlazar(tx: Tx, empresaId: string): Promise<void> {
  const empresa = await tx.cliente.findUnique({ where: { id: empresaId }, select: { id: true } });
  if (!empresa) {
    throw new EmpresaNoEncontradaParaBeneficiarioError(empresaId);
  }
}

/** NIT imposible (DV en un NIT con letras, NIT demasiado largo para el DV). */
export class BeneficiarioDatosInvalidosError extends Error {
  public readonly status = 422;
  public readonly codigo = "BENEFICIARIO_DATOS_INVALIDOS" as const;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "BeneficiarioDatosInvalidosError";
  }
}

// ─── NIT ──────────────────────────────────────────────────────────────────────

/** "800.154.017-8", "NIT 800154017 - 8": DV pegado con guion (mismo patrón que `cxp_nit_base`). */
const RE_DV_PEGADO = /^(?:NIT[\s.:]*)?[0-9.\s]+-\s*([0-9])$/i;

/**
 * Resuelve el NIT que se guarda (CxP v2, sin adivinar el DV):
 *  - NIT colombiano (solo dígitos, puntos, espacios): si hay DV (campo aparte
 *    o pegado con guion) se valida con el algoritmo DIAN y se guarda
 *    "base-DV"; si no, se guarda la base (solo dígitos).
 *  - Con letras (extranjero, pruebas): se guarda tal cual, sin DV.
 * `nitBase` = lo que calculará el trigger `trg_beneficiario_nit_base`.
 */
export function resolverNitFicha(
  nit: string | null | undefined,
  dv: number | null | undefined,
): { nit: string | null; nitBase: string | null } {
  const texto = nit?.trim() ?? "";
  if (texto === "") {
    if (dv !== null && dv !== undefined) {
      throw new BeneficiarioDatosInvalidosError("Escribe el NIT para poder validar el dígito de verificación.");
    }
    return { nit: null, nitBase: null };
  }

  const base = nitBaseDe(texto);
  const pegado = RE_DV_PEGADO.exec(texto);
  const dvPegado = pegado ? Number(pegado[1]) : null;

  if (base === null) {
    if (dv !== null && dv !== undefined) {
      throw new BeneficiarioDatosInvalidosError(
        "El dígito de verificación solo aplica a NIT colombianos (solo números).",
      );
    }
    return { nit: texto, nitBase: null };
  }

  const dvs = [dv, dvPegado].filter((d): d is number => d !== null && d !== undefined);
  if (dvs.length === 0) {
    return { nit: base, nitBase: base };
  }
  if (base.length > 15) {
    throw new BeneficiarioDatosInvalidosError("El NIT es demasiado largo para calcular su dígito de verificación.");
  }
  const correcto = dvNit(base);
  for (const d of dvs) {
    if (d !== correcto) {
      throw new NitDvInvalidoError(d, base, correcto);
    }
  }
  return { nit: `${base}-${correcto}`, nitBase: base };
}

function resumen(b: { id: string; nombre: string; nit: string | null }) {
  return { id: b.id, nombre: b.nombre, nit: b.nit };
}

/**
 * Reglas de NIT de una ficha nueva o editada (CxP v2, §A.1 y D.6):
 *  - `NIT_NO_COINCIDE_EMPRESA`: si la ficha es de una empresa, su NIT base debe ser el de la empresa.
 *  - `BENEFICIARIO_EXISTE`: otra ficha con el mismo NIT base (salvo ADMIN "otra cuenta").
 *  - `POSIBLE_BENEFICIARIO_DUPLICADO`: otra ficha con el número sin el último
 *    dígito o con su DV pegado ("¿Es la misma empresa?"), salvo confirmación.
 */
async function validarNitFicha(
  tx: Tx,
  i: {
    nitBase: string | null;
    empresaId: string | null;
    excluirId?: string;
    permitirMismoNit: boolean;
    confirmarOtraFicha: boolean;
  },
): Promise<void> {
  if (i.nitBase === null) return;

  if (i.empresaId) {
    const empresa = await tx.cliente.findUnique({
      where: { id: i.empresaId },
      select: { nombre: true, nit: true },
    });
    const baseEmpresa = empresa ? nitBaseDe(empresa.nit) : null;
    if (empresa && baseEmpresa !== null && baseEmpresa !== i.nitBase) {
      throw new NitNoCoincideEmpresaError(i.nitBase, empresa.nombre, empresa.nit);
    }
  }

  const excluir = i.excluirId ? { id: { not: i.excluirId } } : {};

  if (!i.permitirMismoNit) {
    const mismo = await tx.beneficiario.findFirst({
      where: { nitBase: i.nitBase, ...excluir },
      select: { id: true, nombre: true, nit: true },
      orderBy: { createdAt: "asc" },
    });
    if (mismo) {
      throw new BeneficiarioExisteError(resumen(mismo));
    }
  }

  if (!i.confirmarOtraFicha) {
    const parecidos = candidatosNitParecido(i.nitBase).filter((c) => c !== i.nitBase);
    if (parecidos.length > 0) {
      const existentes = await tx.beneficiario.findMany({
        where: { nitBase: { in: parecidos }, ...excluir },
        select: { id: true, nombre: true, nit: true },
        orderBy: { createdAt: "asc" },
      });
      if (existentes.length > 0) {
        throw new PosibleBeneficiarioDuplicadoError(existentes.map(resumen));
      }
    }
  }
}

/**
 * Al cambiar el NIT base de una ficha, sus facturas cambian de llave
 * (`trg_beneficiario_reclave`). Si alguna quedaría repetida con otra factura
 * del proveedor nuevo, se rechaza con el mensaje claro (y no con el P2002).
 */
async function verificarReclaveFacturas(
  tx: Tx,
  ficha: { id: string; nombre: string; nombreCorto: string | null; numFacturaConEspacio: boolean },
  nitBaseNuevo: string | null,
): Promise<void> {
  const claveNueva = claveProveedorDeFicha({ id: ficha.id, nitBase: nitBaseNuevo });
  const propias = await tx.facturaProveedor.findMany({
    where: { beneficiarioId: ficha.id, proveedorClave: { not: null }, numFacturaNormalizado: { not: null } },
    select: { numFactura: true, numFacturaNormalizado: true },
  });
  if (propias.length === 0) return;

  const choque = await tx.facturaProveedor.findFirst({
    where: {
      numFacturaNormalizado: { in: propias.flatMap((f) => (f.numFacturaNormalizado ? [f.numFacturaNormalizado] : [])) },
      OR: [{ beneficiarioId: null }, { beneficiarioId: { not: ficha.id } }],
      AND: [
        {
          OR: [
            { proveedorClave: claveNueva },
            ...(nitBaseNuevo !== null ? [{ beneficiario: { nitBase: nitBaseNuevo } }] : []),
          ],
        },
      ],
    },
    select: {
      id: true,
      numFacturaNormalizado: true,
      tramite: { select: { consecutivo: true, anio: true, numero: true } },
    },
  });
  if (!choque) return;

  const propia = propias.find((f) => f.numFacturaNormalizado === choque.numFacturaNormalizado);
  throw new FacturaDuplicadaError({
    numFactura: numeroFacturaVisible(propia?.numFactura ?? choque.numFacturaNormalizado ?? "", ficha.numFacturaConEspacio),
    proveedor: ficha.nombreCorto?.trim() || ficha.nombre,
    doCorto: doCorto(choque.tramite.anio, choque.tramite.numero),
    consecutivo: choque.tramite.consecutivo,
    facturaId: choque.id,
  });
}

/** P2002 de la llave de facturas al re-clavar (carrera con otra alta) → mensaje claro. */
function traducirChoque(e: unknown): unknown {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2002" &&
    JSON.stringify(e.meta ?? {}).match(/proveedorClave|numFacturaNormalizado/)
  ) {
    return new CxpError(
      409,
      "FACTURA_DUPLICADA",
      "Con ese NIT, una factura de esta ficha quedaría repetida con otra del mismo proveedor. Revisa las facturas antes de cambiar el NIT.",
    );
  }
  return e;
}

/** ¿`nit` (+ `dv`) es exactamente lo que ya está guardado? ("800154017" + 8 = "800154017-8"). */
function esElNitGuardado(nit: string | null | undefined, dv: number | null | undefined, guardado: string | null): boolean {
  const texto = nit?.trim() || null;
  if (dv === null || dv === undefined) return texto === guardado;
  if (texto === null || guardado === null) return false;
  return `${texto}-${dv}` === guardado || (texto === guardado && guardado.endsWith(`-${dv}`));
}

function textoOpcional(v: string | null | undefined): string | null {
  return v?.trim() || null;
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function listarBeneficiarios(query?: string, empresaId?: string): Promise<Beneficiario[]> {
  const q = query?.trim();
  const digitos = q ? q.replace(/[^0-9]/g, "") : "";
  return prisma.beneficiario.findMany({
    where: {
      // Fichas de pago enlazadas a una empresa (puente Beneficiario.empresaId, M5).
      ...(empresaId ? { empresaId } : {}),
      ...(q
        ? {
            OR: [
              { nombre: { contains: q, mode: "insensitive" } },
              { nombreCorto: { contains: q, mode: "insensitive" } },
              { nit: { contains: q, mode: "insensitive" } },
              // "800.154.017" encuentra la ficha guardada como "800154017-8".
              ...(digitos.length >= 3 ? [{ nitBase: { contains: digitos } }] : []),
            ],
          }
        : {}),
    },
    orderBy: { nombre: "asc" },
  });
}

export async function crearBeneficiario(
  input: CrearBeneficiarioInput,
  usuarioId: string,
  opciones: OpcionesFicha = {},
): Promise<Beneficiario> {
  const { nit, nitBase } = resolverNitFicha(input.nit, input.dv);
  const empresaId = input.empresaId ?? null;

  return prisma.$transaction(async (tx) => {
    // Serializa altas con el mismo NIT base (dos pantallas creando la misma ficha a la vez).
    if (nitBase !== null) {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`beneficiario-nit:${nitBase}`}))`);
    }
    if (empresaId) {
      await validarEmpresaParaEnlazar(tx, empresaId);
    }
    await validarNitFicha(tx, {
      nitBase,
      empresaId,
      permitirMismoNit: opciones.permitirMismoNit ?? false,
      confirmarOtraFicha: input.confirmarOtraFicha ?? false,
    });

    const beneficiario = await tx.beneficiario.create({
      data: {
        nombre: input.nombre.trim(),
        nit,
        banco: textoOpcional(input.banco),
        numCuenta: textoOpcional(input.numCuenta),
        empresaId,
        nombreCorto: textoOpcional(input.nombreCorto)?.toUpperCase() ?? null,
        numFacturaConEspacio: input.numFacturaConEspacio ?? false,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "Beneficiario",
        entidadId: beneficiario.id,
        accion: "CREATE_BENEFICIARIO",
        usuarioId,
        despues: normalizeSerializable({
          ...beneficiario,
          ...(input.confirmarOtraFicha ? { confirmoOtraFicha: true } : {}),
          ...(opciones.permitirMismoNit ? { otraCuentaMismoProveedor: true } : {}),
        }),
      },
    });

    return beneficiario;
  });
}

export async function actualizarBeneficiario(
  id: string,
  input: Partial<CrearBeneficiarioInput>,
  usuarioId: string,
  opciones: OpcionesFicha = {},
): Promise<Beneficiario> {
  const existe = await prisma.beneficiario.findUnique({ where: { id } });
  if (!existe) throw new BeneficiarioNoEncontradoError(id);

  // La pantalla manda todos los campos en cada guardado: si el NIT (y DV) es el
  // mismo que ya está guardado, no se revalida (una ficha vieja con un DV mal
  // digitado no debe impedir cambiar, por ejemplo, el banco).
  const tocaNit =
    (input.nit !== undefined || (input.dv !== undefined && input.dv !== null)) &&
    !esElNitGuardado(input.nit !== undefined ? input.nit : existe.nit, input.dv, existe.nit);
  const nitResuelto = tocaNit
    ? resolverNitFicha(input.nit !== undefined ? input.nit : existe.nit, input.dv)
    : null;
  const nitBaseFinal = nitResuelto ? nitResuelto.nitBase : existe.nitBase;
  const cambiaNitBase = nitResuelto !== null && nitResuelto.nitBase !== existe.nitBase;
  const empresaFinal = input.empresaId !== undefined ? input.empresaId : existe.empresaId;
  const cambiaEmpresa = empresaFinal !== existe.empresaId;

  try {
    return await prisma.$transaction(async (tx) => {
      if (cambiaNitBase && nitBaseFinal !== null) {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`beneficiario-nit:${nitBaseFinal}`}))`);
      }
      if (cambiaEmpresa && empresaFinal) {
        await validarEmpresaParaEnlazar(tx, empresaFinal);
      }
      if (cambiaNitBase || cambiaEmpresa) {
        await validarNitFicha(tx, {
          nitBase: nitBaseFinal,
          empresaId: empresaFinal,
          excluirId: id,
          // Solo se revisan fichas repetidas cuando cambia el NIT (cambiar solo la empresa no crea una ficha nueva).
          permitirMismoNit: !cambiaNitBase || (opciones.permitirMismoNit ?? false),
          confirmarOtraFicha: !cambiaNitBase || (input.confirmarOtraFicha ?? false),
        });
      }
      if (cambiaNitBase) {
        await verificarReclaveFacturas(tx, existe, nitBaseFinal);
      }

      const actualizado = await tx.beneficiario.update({
        where: { id },
        data: {
          ...(input.nombre !== undefined ? { nombre: input.nombre.trim() } : {}),
          ...(nitResuelto ? { nit: nitResuelto.nit } : {}),
          ...(input.banco !== undefined ? { banco: textoOpcional(input.banco) } : {}),
          ...(input.numCuenta !== undefined ? { numCuenta: textoOpcional(input.numCuenta) } : {}),
          ...(input.empresaId !== undefined ? { empresaId: input.empresaId } : {}),
          ...(input.nombreCorto !== undefined
            ? { nombreCorto: textoOpcional(input.nombreCorto)?.toUpperCase() ?? null }
            : {}),
          ...(input.numFacturaConEspacio !== undefined ? { numFacturaConEspacio: input.numFacturaConEspacio } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          entidad: "Beneficiario",
          entidadId: id,
          accion: "UPDATE_BENEFICIARIO",
          usuarioId,
          antes: normalizeSerializable(existe),
          despues: normalizeSerializable({
            ...actualizado,
            ...(input.confirmarOtraFicha ? { confirmoOtraFicha: true } : {}),
            ...(opciones.permitirMismoNit && cambiaNitBase ? { otraCuentaMismoProveedor: true } : {}),
          }),
        },
      });

      return actualizado;
    });
  } catch (e) {
    throw traducirChoque(e);
  }
}

/**
 * «Enlazar ficha de pago» con un clic (M5, rama Coldex). Si la empresa ya
 * tiene una ficha enlazada la devuelve tal cual (idempotente, sin auditoría);
 * si no, aplica la regla de `asegurarBeneficiarioDeEmpresa`: enlaza una ficha
 * suelta con el mismo NIT base (clave de proveedor de CxP v2, `cxp_nit_base`,
 * sin adivinar el DV) o crea una nueva con el nombre y el NIT de la empresa.
 * Deja `AuditLog` `ENLAZAR_BENEFICIARIO_EMPRESA`.
 */
export async function enlazarBeneficiarioEmpresa(empresaId: string, usuarioId: string): Promise<Beneficiario> {
  return prisma.$transaction(async (tx) => {
    const empresa = await tx.cliente.findUnique({
      where: { id: empresaId },
      select: { id: true, nombre: true, nit: true },
    });
    if (!empresa) {
      throw new EmpresaNoEncontradaError(empresaId);
    }

    const yaEnlazado = await tx.beneficiario.findFirst({ where: { empresaId }, orderBy: { createdAt: "asc" } });
    if (yaEnlazado) return yaEnlazado;

    const base = nitBaseDe(empresa.nit);
    if (base !== null) {
      // Misma serialización que el alta de fichas con ese NIT base.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`beneficiario-nit:${base}`}))`);
    }
    const beneficiario = await asegurarBeneficiarioDeEmpresa(tx, empresa);

    await tx.auditLog.create({
      data: {
        entidad: "Beneficiario",
        entidadId: beneficiario.id,
        accion: "ENLAZAR_BENEFICIARIO_EMPRESA",
        usuarioId,
        despues: normalizeSerializable(beneficiario),
      },
    });

    return beneficiario;
  });
}
