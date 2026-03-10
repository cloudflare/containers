FROM golang:1.24-alpine AS builder
WORKDIR /src
COPY container_src/main.go ./main.go
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /server ./main.go

FROM scratch
COPY --from=builder /server /server
EXPOSE 8080
CMD ["/server"]
