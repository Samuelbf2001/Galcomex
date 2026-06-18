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
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN chmod +x docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
