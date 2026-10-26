FROM node:24-alpine
WORKDIR /srv
COPY package.json /srv/package.json
RUN npm install --omit=dev --no-audit --no-fund >/dev/null
COPY worker.js /srv/worker.js
CMD ["node", "/srv/worker.js"]
