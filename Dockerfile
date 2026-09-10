FROM node:20-alpine
RUN npm install -g @bitwarden/cli@latest
COPY entrypoint.sh stage-export.sh stage-import.sh sync.mjs /
ENTRYPOINT ["/bin/sh","/entrypoint.sh"]
