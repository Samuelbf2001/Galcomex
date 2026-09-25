-- Gestión de usuarios por el ADMIN (2026-09-24).
--
-- `activo`: el ADMIN puede desactivar una cuenta sin borrarla (conserva su
-- historial en AuditLog, DOs, pagos...). Un usuario desactivado no inicia sesión.
-- `debeCambiarPassword`: la cuenta entra con una clave temporal (usuario nuevo o
-- clave restablecida) y debe cambiarla antes de usar el sistema.
--
-- Los usuarios existentes quedan ACTIVOS y SIN obligación de cambiar la clave:
-- desplegar esta migración no interrumpe a nadie.
ALTER TABLE "user" ADD COLUMN "activo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "debeCambiarPassword" BOOLEAN NOT NULL DEFAULT false;
