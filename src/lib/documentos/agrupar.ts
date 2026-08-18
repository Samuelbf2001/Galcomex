/**
 * Agrupamiento genérico y puro (sin BD, sin storage) usado para presentar
 * los documentos de un cliente agrupados por categoría en la UI —
 * ver `src/components/clientes/documentos-cliente.tsx`.
 *
 * Se mantiene sin dependencias de servidor (prisma, storage) a propósito
 * para poder importarse tanto desde el servicio (server) como desde un
 * componente cliente, y para poder testearse sin necesidad de BD.
 */
export function agruparPor<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
): Record<string, T[]> {
  const result: Record<string, T[]> = {};

  for (const item of items) {
    const key = keyFn(item);
    const grupo = result[key];
    if (grupo) {
      grupo.push(item);
    } else {
      result[key] = [item];
    }
  }

  return result;
}
