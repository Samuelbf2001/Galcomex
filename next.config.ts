import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Paquetes de servidor que no deben pasar por el bundler de Next: cargan
  // binarios/fuentes en tiempo de ejecución (react-pdf), leen el sistema de
  // archivos (xlsx) o abren sockets (minio). Se resuelven desde node_modules,
  // que el Dockerfile instala completo (npm install + COPY . .).
  serverExternalPackages: ["@react-pdf/renderer", "xlsx", "minio"],
  // La app no usa next/image (no hay imágenes remotas que optimizar); esto
  // apaga por completo el endpoint /_next/image, que tuvo una vulnerabilidad
  // conocida de SSRF/DoS en versiones de Next.
  images: { unoptimized: true },
  // Cabeceras de seguridad básicas para todas las rutas. Sin CSP global a
  // propósito: una CSP estricta rompería la app (scripts/estilos inline de
  // Next, etc.) y requiere un trabajo aparte con permiso explícito.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
