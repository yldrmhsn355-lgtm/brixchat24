FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
ENV CI=true
RUN corepack enable
RUN apk add --no-cache su-exec
WORKDIR /app
COPY . .
COPY docker-entrypoint.sh /usr/local/bin/brixchat24-entrypoint
RUN chmod +x /usr/local/bin/brixchat24-entrypoint
RUN pnpm install --filter @brixchat/worker... --frozen-lockfile && pnpm --filter @brixchat/worker build
RUN mkdir -p /app/.data && chown -R node:node /app/.data
ENTRYPOINT ["/usr/local/bin/brixchat24-entrypoint"]
CMD ["node","node_modules/tsx/dist/cli.mjs","apps/worker/src/index.ts"]
