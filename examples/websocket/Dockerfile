# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /usr/src/app

COPY container_src/package.json package.json
RUN npm install

COPY container_src/server.js server.js

EXPOSE 8080
STOPSIGNAL SIGINT