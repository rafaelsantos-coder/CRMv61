FROM node:20-alpine

# Instala cliente PostgreSQL para rodar migrations
RUN apk add --no-cache postgresql-client

WORKDIR /app

# Copia dependências primeiro (melhor cache de build)
COPY backend/package*.json ./
RUN npm install --omit=dev

# Copia código backend
COPY backend/ .

# Copia frontend (public)
COPY public/ ./public/

ENV NODE_ENV=production

EXPOSE 3000

# Inicia o servidor
CMD ["node", "src/server.js"]
