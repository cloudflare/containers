# syntax=docker/dockerfile:1

ARG TIGRISFS_VERSION=v1.2.1

FROM golang:1.24-alpine AS build

WORKDIR /app

COPY container_src/go.mod ./
RUN go mod download

COPY container_src/*.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -o /server

FROM alpine:3.20

ARG TIGRISFS_VERSION

RUN apk add --no-cache ca-certificates fuse fuse-dev curl bash

RUN set -e; \
    ARCH=$(uname -m); \
    case "$ARCH" in \
        x86_64) ARCH="amd64" ;; \
        aarch64) ARCH="arm64" ;; \
    esac; \
    curl -fL "https://github.com/tigrisdata/tigrisfs/releases/download/${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION#v}_linux_${ARCH}.tar.gz" | \
    tar -xzf - -C /usr/local/bin/

COPY --from=build /server /server

COPY container_src/startup.sh /startup.sh
RUN chmod +x /startup.sh

EXPOSE 8080

CMD ["/startup.sh"]
