FROM node:24-alpine
WORKDIR /srv
COPY package.json /srv/package.json
RUN npm install --omit=dev --no-audit --no-fund >/dev/null
COPY server.js /srv/server.js
EXPOSE 3000
CMD ["node", "/srv/server.js"]
