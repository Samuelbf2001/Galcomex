"use client";

/** Último recurso: error en el layout raíz. Debe renderizar html y body propios. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f1f5f9", color: "#0f172a" }}>
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20 }}>
          <div style={{ maxWidth: 420, background: "#fff", border: "1px solid #fecdd3", padding: 24 }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>Galcomex no pudo iniciar</h1>
            <p style={{ fontSize: 14, color: "#475569", marginTop: 8 }}>
              Ocurrió un error inesperado al cargar la aplicación. Reintenta; si continúa, avisa a
              SixTeam.
            </p>
            {error.digest ? (
              <p style={{ fontSize: 12, color: "#64748b", fontFamily: "monospace" }}>Referencia: {error.digest}</p>
            ) : null}
            <button
              type="button"
              onClick={reset}
              style={{ marginTop: 16, height: 40, width: "100%", background: "#020617", color: "#fff", border: 0, fontWeight: 600, cursor: "pointer" }}
            >
              Reintentar
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
