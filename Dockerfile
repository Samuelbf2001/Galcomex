FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache libc6-compat

# Instalar dependencias (cacheado hasta que cambie package.json)
COPY package*.json ./
RUN npm install

# Copiar todo el source (incluyendo el schema.prisma actualizado)
COPY . .

# Generar Prisma client desde el schema actual (siempre fresco)
RUN npx prisma generate

# Variable pública bakeada en el bundle
ARG NEXT_PUBLIC_APP_URL=https://galcomex.sixteam.pro
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# El entrypoint va con ruta absoluta: sin ella el PATH resuelve el docker-entrypoint.sh
# de la imagen base node y las migraciones nunca corren (visto en produccion 2026-09-18).
# Se quitan retornos de carro por si el checkout vino con CRLF.
RUN sed -i s/r$// docker-entrypoint.sh && chmod +x docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
