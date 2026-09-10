-- CreateIndex
CREATE INDEX "anticipo_clienteId_idx" ON "anticipo"("clienteId");

-- CreateIndex
CREATE INDEX "anticipo_fecha_idx" ON "anticipo"("fecha");

-- CreateIndex
CREATE INDEX "aplicacion_anticipo_tramiteId_idx" ON "aplicacion_anticipo"("tramiteId");

-- CreateIndex
CREATE INDEX "aplicacion_anticipo_anticipoId_idx" ON "aplicacion_anticipo"("anticipoId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "borrador_factura_tramiteId_estado_idx" ON "borrador_factura"("tramiteId", "estado");

-- CreateIndex
CREATE INDEX "borrador_factura_createdAt_idx" ON "borrador_factura"("createdAt");

-- CreateIndex
CREATE INDEX "checklist_item_tramiteId_idx" ON "checklist_item"("tramiteId");

-- CreateIndex
CREATE INDEX "documento_tramiteId_eliminado_idx" ON "documento"("tramiteId", "eliminado");

-- CreateIndex
CREATE INDEX "estado_log_tramiteId_idx" ON "estado_log"("tramiteId");

-- CreateIndex
CREATE INDEX "factura_clienteId_idx" ON "factura"("clienteId");

-- CreateIndex
CREATE INDEX "factura_fecha_idx" ON "factura"("fecha");

-- CreateIndex
CREATE INDEX "factura_proveedor_beneficiarioId_idx" ON "factura_proveedor"("beneficiarioId");

-- CreateIndex
CREATE INDEX "factura_proveedor_tramiteId_estado_idx" ON "factura_proveedor"("tramiteId", "estado");

-- CreateIndex
CREATE INDEX "pago_factura_facturaId_idx" ON "pago_factura"("facturaId");

-- CreateIndex
CREATE INDEX "pago_factura_fecha_idx" ON "pago_factura"("fecha");

-- CreateIndex
CREATE INDEX "pago_tramite_tramiteId_idx" ON "pago_tramite"("tramiteId");

-- CreateIndex
CREATE INDEX "pago_tramite_grupoPagoId_idx" ON "pago_tramite"("grupoPagoId");

-- CreateIndex
CREATE INDEX "pago_tramite_fechaRealPago_idx" ON "pago_tramite"("fechaRealPago");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE INDEX "tramite_do_clienteId_idx" ON "tramite_do"("clienteId");

-- CreateIndex
CREATE INDEX "tramite_do_estado_idx" ON "tramite_do"("estado");

-- CreateIndex
CREATE INDEX "tramite_do_estado_fechaSalidaCarga_idx" ON "tramite_do"("estado", "fechaSalidaCarga");

