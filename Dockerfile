FROM node:24-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app

FROM base AS build

# Prisma doit connaître le type de base au moment de générer son client.
# Cette URL factice n'est utilisée que pendant la construction de l'image.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build

COPY package.json package-lock.json* ./

RUN npm ci

COPY . .

RUN npm exec prisma generate
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

FROM base AS runner

ENV NODE_ENV=production

COPY --from=build /app /app

EXPOSE 3000

CMD ["npm", "run", "docker-start"]
