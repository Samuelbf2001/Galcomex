import { Prisma } from "@prisma/client";

import { EmpresaMismoNitError, EmpresasRepetidasPorNitError, type EmpresaResumen } from "@/lib/beneficiarios/errores";
import { nitBaseDe } from "@/lib/cxp/saldos";

type Tx = Prisma.TransactionClient;

/**
 * "PENDIENTE-NIT-ASCINTER", "SIN-NIT-…", "PROVISIONAL", "N/A": un marcador
 * puesto mientras se consigue el NIT, no un NIT real. No se copia a la ficha
 * de pago (iría a Siigo como NIT del tercero) ni sirve para buscar repetidos.
 */
const RE_NIT_PROVISIONAL =
  /^(PENDIENTE|SIN[\s_-]*NIT|PROVISIONAL|POR[\s_-]*(DEFINIR|CONFIRMAR)|TEMPORAL|N[\s./-]*[AD]\b|NN\b|NINGUNO|NO[\s_-]*TIENE|X+\b)/i;

export function esNitProvisional(nit: string | null | undefined): boolean {
  const texto = nit?.trim() ?? "";
  return texto !== "" && RE_NIT_PROVISIONAL.test(texto);
}

/**
 * ¿Sirve como NIT para identificar a un proveedor? No si es un marcador
 * provisional ni si es basura ("0", ".", "NA"): al menos un dígito y 5
 * letras o números. Un NIT extranjero real ("US-EIN 12-3456789") sí sirve.
 */
export function esNitUtil(nit: string | null | undefined): boolean {
  const texto = nit?.trim() ?? "";
  if (texto === "" || esNitProvisional(texto)) return false;
  const alfanumericos = texto.replace(/[^0-9A-Za-z]/g, "");
  return /[0-9]/.test(texto) && alfanumericos.length >= 5 && /[1-9]/.test(alfanumericos);
}

/** Llave del candado por NIT: la misma que usan el alta de fichas y `asegurarBeneficiarioDeEmpresa`. */
export function llaveCandadoNit(nit: string): string | null {
  const texto = nit.trim();
  if (!esNitUtil(texto)) return null;
  const base = nitBaseDe(texto);
  return base !== null ? `beneficiario-nit:${base}` : `beneficiario-nit-texto:${texto.toUpperCase()}`;
}

/**
 * Serializa en la transacción todo lo que crea empresas o fichas con este NIT
 * (dos pantallas a la vez). Se toma ANTES de escribir la fila de la empresa,
 * para que el orden de candados sea siempre NIT → fila.
 */
export async function bloquearNit(tx: Tx, nit: string | null | undefined): Promise<void> {
  const llave = nit ? llaveCandadoNit(nit) : null;
  if (llave) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${llave}))`);
  }
}

/**
 * Empresa que ya tiene este NIT: mismo NIT base si es colombiano ("800154017"
 * = "800.154.017-8"), o el mismo texto si es extranjero. Los NIT provisionales
 * o sin sentido no se comparan (dos empresas «PENDIENTE-…» no son la misma).
 * Si hay más de una, el dato ya está repetido y no se escoge una a ciegas
 * (`EMPRESA_MISMO_NIT`).
 *
 * Recorre `cliente` en memoria porque la tabla no guarda el NIT base; son
 * decenas de filas (una empresa, no un SaaS).
 */
export async function buscarEmpresaPorNit(
  tx: Tx,
  nit: string,
  excluirId?: string,
): Promise<(EmpresaResumen & { esProveedor: boolean }) | null> {
  const texto = nit.trim();
  if (!esNitUtil(texto)) return null;

  const base = nitBaseDe(texto);
  const empresas = await tx.cliente.findMany({
    select: { id: true, nombre: true, nit: true, esProveedor: true },
    orderBy: { createdAt: "asc" },
  });
  const iguales = empresas.filter(
    (e) =>
      e.id !== excluirId &&
      (base !== null ? nitBaseDe(e.nit) === base : e.nit.trim().toUpperCase() === texto.toUpperCase()),
  );
  if (iguales.length > 1) {
    throw new EmpresasRepetidasPorNitError(iguales.map((e) => ({ id: e.id, nombre: e.nombre, nit: e.nit })));
  }
  return iguales[0] ?? null;
}

/**
 * Alta o cambio de NIT de una empresa: otra empresa con el mismo NIT (con o
 * sin dígito de verificación) sería la misma empresa repetida, y sus datos de
 * pago se sumarían en las dos cuentas → `EMPRESA_MISMO_NIT` (409).
 */
export async function verificarNitEmpresaLibre(tx: Tx, nit: string, excluirId?: string): Promise<void> {
  const existente = await buscarEmpresaPorNit(tx, nit, excluirId);
  if (existente) {
    throw new EmpresaMismoNitError({ id: existente.id, nombre: existente.nombre, nit: existente.nit });
  }
}

/** "Transportes Pérez S.A.S." = "TRANSPORTES PEREZ SAS" = "Transportes Perez": para avisar repetidos por nombre. */
export function nombreComparable(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\b(S A S|SAS|S A|SA|LTDA|LIMITADA|Y CIA|CIA|E U|EU|S EN C|SC)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Empresa con el mismo nombre (sin tildes, puntos ni «S.A.S.»): el aviso antes
 * de crear una empresa nueva para una ficha. Cubre la empresa con NIT
 * provisional (ASCINTER «PENDIENTE-NIT-…»), que por NIT no se encuentra.
 */
export async function buscarEmpresaPorNombre(tx: Tx, nombre: string): Promise<EmpresaResumen | null> {
  const buscado = nombreComparable(nombre);
  if (buscado === "") return null;
  const empresas = await tx.cliente.findMany({
    select: { id: true, nombre: true, nit: true },
    orderBy: { createdAt: "asc" },
  });
  return empresas.find((e) => nombreComparable(e.nombre) === buscado) ?? null;
}
