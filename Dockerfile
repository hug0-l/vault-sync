FROM node:20-alpine
RUN npm install -g @bitwarden/cli@latest
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
ENV PORT=8770 KEY_FILE=/run/secrets/key DATA_DIR=/data TZ=Asia/Hong_Kong
VOLUME /data
EXPOSE 8770
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO /dev/null http://127.0.0.1:8770/api/status || exit 1
CMD ["node", "server.mjs"]
