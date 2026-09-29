/**
 * Errores de dominio del envío a Siigo (patrón `class XError { status }`, ver
 * `src/lib/http/errors.ts`). Las rutas los traducen con `domainErrorResponse`.
 */

/** El reclamo del envío no procedió: ya enviado, en curso o sin confirmar. → 409 */
export class EnvioSiigoBloqueadoError extends Error {
  public readonly status = 409;
  public readonly codigo = "SIIGO_ENVIO_BLOQUEADO";
  constructor(message: string) {
    super(message);
    this.name = "EnvioSiigoBloqueadoError";
  }
}

/** «Revisar en SIIGO» / «Liberar» no aplican al estado actual del envío. → 409 */
export class EnvioSiigoNoResolubleError extends Error {
  public readonly status = 409;
  public readonly codigo = "SIIGO_ENVIO_NO_RESOLUBLE";
  constructor(message: string) {
    super(message);
    this.name = "EnvioSiigoNoResolubleError";
  }
}

/** El borrador no existe. → 404 */
export class BorradorSiigoNoEncontradoError extends Error {
  public readonly status = 404;
  constructor() {
    super("Borrador no encontrado");
    this.name = "BorradorSiigoNoEncontradoError";
  }
}

/** No se pudo consultar Siigo (credenciales, red, error HTTP). → 502 / 503 */
export class ConsultaSiigoError extends Error {
  public readonly status: number;
  constructor(message: string, status: 502 | 503) {
    super(message);
    this.name = "ConsultaSiigoError";
    this.status = status;
  }
}
