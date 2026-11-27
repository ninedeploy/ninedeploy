# The site is built in one stage; the image that runs holds what was built and a web server, no Node.
FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY astro.config.mjs tsconfig.json ./
COPY src ./src
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY deploy/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
