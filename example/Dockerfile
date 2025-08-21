FROM golang:1.24-alpine AS build

WORKDIR /app

COPY container_src/go.mod ./
RUN go mod download
# Add 5 layers, each 300MB, for a total of 1.5GB
RUN dd if=/dev/urandom of=/dummy_file_1 bs=1048576 count=300
RUN dd if=/dev/urandom of=/dummy_file_2 bs=1048576 count=300
RUN dd if=/dev/urandom of=/dummy_file_3 bs=1048576 count=300
RUN dd if=/dev/urandom of=/dummy_file_4 bs=1048576 count=300
RUN dd if=/dev/urandom of=/dummy_file_5 bs=1048576 count=300

COPY container_src/*.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -o /server

FROM scratch
COPY --from=build /server /server
COPY --from=build /dummy_file_1 /dummy_file_2 /dummy_file_3 /dummy_file_4 /dummy_file_5 /
EXPOSE 8080

# Run
CMD ["/server"]