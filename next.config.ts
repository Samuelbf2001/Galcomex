import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Paquetes de servidor que no deben pasar por el bundler de Next: cargan
  // binarios/fuentes en tiempo de ejecución (react-pdf), leen el sistema de
  // archivos (xlsx) o abren sockets (minio). Se resuelven desde node_modules,
  // que el Dockerfile instala completo (npm install + COPY . .).
  serverExternalPackages: ["@react-pdf/renderer", "xlsx", "minio"],
};

export default nextConfig;
