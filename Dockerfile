FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev

COPY engines ./engines
COPY pipeline ./pipeline
COPY cache ./cache
COPY config ./config
COPY index-prowlarr.js index-sites.js ./

ENV DB_PATH=/data/cache.db
RUN mkdir -p /data

EXPOSE 7001 7003

CMD ["node", "index-prowlarr.js"]
