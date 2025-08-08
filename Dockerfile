# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
COPY package.json pnpm-lock.yaml* ./
# Avoid running root postinstall before client/server dirs are present
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts

COPY client/package.json client/pnpm-lock.yaml* ./client/
RUN cd client && pnpm install --frozen-lockfile || pnpm install

COPY server/package.json server/pnpm-lock.yaml* ./server/
RUN cd server && pnpm install --frozen-lockfile || pnpm install

FROM base AS build
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter write-collab-client... --filter write-collab-server... -w run -r build || (cd client && pnpm build && cd ../server && pnpm build)

FROM base AS runner
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
# Ensure server runtime deps are available at /app/node_modules for resolution from dist/
COPY --from=build /app/server/node_modules ./node_modules
EXPOSE 3000 3001
CMD ["node", "dist/server/index.js"]


