-- CxP v2 · M1 — Tipos (docs/CXP-PROVEEDORES.md)
--
-- Solo enums. El `ADD VALUE` va solo en su archivo: PostgreSQL no deja usar un
-- valor de enum recién agregado dentro de la misma transacción, y M3 escribe
-- 'PARCIAL'. Aditiva: no toca datos.

ALTER TYPE "EstadoFacturaProveedor" ADD VALUE IF NOT EXISTS 'PARCIAL';

-- CreateEnum
CREATE TYPE "Moneda" AS ENUM ('COP', 'USD');

-- CreateEnum
CREATE TYPE "TipoAjusteFacturaProveedor" AS ENUM ('NOTA_CREDITO', 'RETENCION', 'DESCUENTO', 'DIFERENCIA_CAMBIO', 'REDONDEO', 'LEGADO');

-- CreateEnum
CREATE TYPE "EstadoPagoGrupo" AS ENUM ('ACTIVO', 'ANULADO');

-- CreateEnum
CREATE TYPE "CostoBancarioAsumidoPor" AS ENUM ('GALCOMEX', 'PRIMER_DO', 'PRORRATEADO');
