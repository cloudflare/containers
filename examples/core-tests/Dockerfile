# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /usr/src/app

RUN echo '{"name": "test-container", "version": "1.0.0"}' > package.json

COPY container_src/server.js server.js

EXPOSE 8080
STOPSIGNAL SIGINT