FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache libc6-compat

# El npm que trae node:22-alpine (10.9.x) rechaza "npm ci" con este lockfile
# por un peerDependency OPCIONAL (magicast, de prisma→c12) que reporta como
# "Missing" aunque sea opcional; npm 11 ya no tiene ese falso positivo.
# /app pasa al usuario "node" antes de instalar: todo lo que genere el build
# (node_modules, .next, prisma client) ya nace suyo y no hace falta un
# chown -R que duplicaría la capa de node_modules.
RUN npm install -g npm@11 && chown node:node /app

# La app se construye y corre sin privilegios de root.
USER node

# Instalar dependencias (cacheado hasta que cambie package.json)
COPY --chown=node:node package*.json ./
RUN npm ci

# Copiar todo el source (incluyendo el schema.prisma actualizado)
COPY --chown=node:node . .

# Generar Prisma client desde el schema actual (siempre fresco)
RUN npx prisma generate

# Variable pública bakeada en el bundle
ARG NEXT_PUBLIC_APP_URL=https://galcomex.sixteam.pro
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# El entrypoint va con ruta absoluta: sin ella el PATH resuelve el docker-entrypoint.sh
# de la imagen base node y las migraciones nunca corren (visto en producción 2026-09-18).
# Se quitan retornos de carro por si el checkout vino con CRLF.
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
