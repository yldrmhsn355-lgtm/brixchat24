FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
ENV CI=true
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_REALTIME_URL=
ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --filter @brixchat/web... --frozen-lockfile && pnpm --filter @brixchat/web build
USER node
EXPOSE 3000
CMD ["node","apps/web/node_modules/next/dist/bin/next","start","apps/web"]
