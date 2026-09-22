-- Ciudad BGT (Bogotá): Sesderma tiene 21 DOs `DO.BGT26-NNNN` en el histórico
-- 2026 (entrega 2026-09-21) y la cartera propia ya traía `BGT25-XXXX`.
-- ADD VALUE se aplica con `prisma migrate deploy` (PostgreSQL >= 12); el valor
-- nuevo no se usa en esta misma migración.
ALTER TYPE "Ciudad" ADD VALUE IF NOT EXISTS 'BGT';
