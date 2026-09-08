FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY schemas ./schemas
COPY fixtures ./fixtures
COPY agentcore/app/who-decides-agent/main.ts ./agentcore/app/who-decides-agent/main.ts
RUN ./node_modules/.bin/esbuild agentcore/app/who-decides-agent/main.ts --bundle --platform=node --format=cjs --target=node22 --packages=external --define:import.meta.url=undefined --outfile=dist/agent.cjs
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production WD_AGENT_PORT=8080 WD_AGENT_DATA_DIR=/mnt/data/agent
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/agent.cjs"]
