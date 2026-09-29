/**
 * Errores de la fase 3 del plan «Empresa + Datos de pago»: toda ficha de pago
 * pertenece a una empresa (salvo la del socio) y no se crean proveedores
 * repetidos por un NIT escrito distinto.
 *
 * Mismo contrato que los errores de dominio del resto del sistema: `status`
 * HTTP, `codigo` estable y mensaje en español para quien opera la pantalla.
 * Las rutas los responden como `{ error, codigo, detalles? }`.
 * Sin dependencias de BD: se puede importar desde el cliente.
 */

export type CodigoErrorFicha =
  | "FICHA_SIN_EMPRESA"
  | "FICHA_SIN_NIT"
  | "FICHA_SOCIO_SIN_EMPRESA"
  | "NIT_DE_OTRA_EMPRESA"
  | "EMPRESA_MISMO_NIT"
  | "EMPRESA_CON_PAGOS"
  | "NIT_DEL_SOCIO"
  | "POSIBLE_EMPRESA_DUPLICADA";

export class FichaError extends Error {
  public readonly status: 409 | 422;
  public readonly codigo: CodigoErrorFicha;
  public readonly detalles: Record<string, unknown> | undefined;
  constructor(status: 409 | 422, codigo: CodigoErrorFicha, mensaje: string, detalles?: Record<string, unknown>) {
    super(mensaje);
    this.name = "FichaError";
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

/** Una ficha (salvo la del socio) no puede quedar sin empresa. */
export class FichaSinEmpresaError extends FichaError {
  constructor() {
    super(
      422,
      "FICHA_SIN_EMPRESA",
      "Todo proveedor debe pertenecer a una empresa. Escoge su empresa (o créala) antes de guardar.",
    );
    this.name = "FichaSinEmpresaError";
  }
}

/** Alta de un proveedor nuevo sin empresa y sin NIT: no hay con qué crear su empresa ni evitar repetidos. */
export class FichaSinNitError extends FichaError {
  constructor() {
    super(
      422,
      "FICHA_SIN_NIT",
      "Para crear un proveedor nuevo escribe su NIT (o su identificación, si es extranjero). Con el NIT se crea su empresa y se evita repetirlo.",
    );
    this.name = "FichaSinNitError";
  }
}

/** La ficha del socio vive sin empresa a propósito. */
export class FichaSocioConEmpresaError extends FichaError {
  constructor() {
    super(422, "FICHA_SOCIO_SIN_EMPRESA", "La ficha de pago del socio no se enlaza a una empresa.");
    this.name = "FichaSocioConEmpresaError";
  }
}

export interface FichaDeOtraEmpresa {
  fichaId: string;
  fichaNombre: string;
  nit: string | null;
  empresaId: string;
  empresaNombre: string;
}

/** El NIT ya es el de un proveedor de OTRA empresa: crear otra ficha lo repetiría. */
export class NitDeOtraEmpresaError extends FichaError {
  constructor(otra: FichaDeOtraEmpresa) {
    super(
      409,
      "NIT_DE_OTRA_EMPRESA",
      `${otra.nit ? `El NIT ${otra.nit}` : "Ese NIT"} ya es del proveedor ${otra.fichaNombre}, de la empresa ${otra.empresaNombre}. Si es la misma empresa, usa esa; si no, revisa el NIT.`,
      { ...otra },
    );
    this.name = "NitDeOtraEmpresaError";
  }
}

export interface EmpresaResumen {
  id: string;
  nombre: string;
  nit: string;
}

/** Dos empresas con el mismo NIT (con o sin dígito de verificación) son la misma empresa repetida. */
export class EmpresaMismoNitError extends FichaError {
  constructor(existente: EmpresaResumen) {
    super(
      409,
      "EMPRESA_MISMO_NIT",
      `Ya existe la empresa ${existente.nombre} con ese NIT (${existente.nit}). Usa esa empresa.`,
      { existente },
    );
    this.name = "EmpresaMismoNitError";
  }
}

/** Ya hay más de una empresa con el mismo NIT: el dato está repetido y no se escoge una a ciegas. */
export class EmpresasRepetidasPorNitError extends FichaError {
  constructor(empresas: EmpresaResumen[]) {
    super(
      409,
      "EMPRESA_MISMO_NIT",
      `Hay más de una empresa con ese NIT (${empresas.map((e) => e.nombre).join(", ")}). Hay que unificarlas antes de seguir.`,
      { empresas },
    );
    this.name = "EmpresasRepetidasPorNitError";
  }
}

/** El NIT es el de la ficha del socio (Luis Martínez): no se vuelve empresa ni se repite. */
export class NitDelSocioError extends FichaError {
  constructor(ficha: { id: string; nombre: string; nit: string | null }) {
    super(
      409,
      "NIT_DEL_SOCIO",
      `Ese NIT es el de la ficha de pago del socio (${ficha.nombre}). Usa esa ficha; el socio no se registra como empresa.`,
      { ficha },
    );
    this.name = "NitDelSocioError";
  }
}

/** Ya hay una empresa con el mismo nombre (sin tildes ni «S.A.S.») y otro NIT o un NIT provisional. */
export class PosibleEmpresaDuplicadaError extends FichaError {
  constructor(existente: EmpresaResumen) {
    super(
      409,
      "POSIBLE_EMPRESA_DUPLICADA",
      `¿Es la misma empresa? Ya existe ${existente.nombre} (NIT ${existente.nit}). Si es la misma, escoge esa empresa o corrige su NIT; si es otra, confírmalo.`,
      { existente },
    );
    this.name = "PosibleEmpresaDuplicadaError";
  }
}

/** Borrar una empresa cuyos datos de pago ya tienen pagos o facturas dejaría esa plata sin dueño. */
export class EmpresaConPagosError extends FichaError {
  constructor() {
    super(
      409,
      "EMPRESA_CON_PAGOS",
      "Esta empresa tiene pagos o facturas de proveedor registrados, o su ficha de pago está en la configuración de Siigo: no se puede borrar.",
    );
    this.name = "EmpresaConPagosError";
  }
}
