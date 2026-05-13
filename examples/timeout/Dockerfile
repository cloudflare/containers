# syntax=docker/dockerfile:1

FROM golang:1.23 AS build
WORKDIR /app

COPY container_src/go.mod ./
RUN go mod download

COPY container_src/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /server

FROM scratch
COPY --from=build /server /server
EXPOSE 8080
CMD ["/server"]
