FROM node:20-alpine AS builder-server

WORKDIR /app
COPY package.json ./
RUN apk add --no-cache python3 make g++ && npm install && apk del python3 make g++
COPY tsconfig.json ./
COPY src/server ./src/server
COPY scripts/build.js ./scripts/build.js
RUN npm run build


FROM node:20-alpine AS builder-renderer

WORKDIR /app/renderer
COPY src/renderer/package.json ./
RUN npm install
COPY src/renderer ./
RUN npm run build


FROM node:20-alpine AS runtime

RUN apk add --no-cache dumb-init python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --production && npm rebuild better-sqlite3 && apk del python3 make g++

COPY --from=builder-server /app/dist ./dist
COPY --from=builder-renderer /app/renderer/dist ./src/renderer/dist

RUN mkdir -p /data

ENV NODE_ENV=production
ENV SUNY_PORT=3000
ENV SUNY_DB_PATH=/data/suny.db

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server/index.js"]
