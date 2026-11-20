# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY mock-lab ./mock-lab
COPY scripts ./scripts
COPY migrations ./migrations
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "dist/src/api.js"]
