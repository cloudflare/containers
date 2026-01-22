# syntax=docker/dockerfile:1

# Stage 1: Build
FROM rust:1.92.0-alpine AS build

WORKDIR /app

# Copy the dependencies first to leverage Docker's cache
COPY container_src/Cargo.toml container_src/Cargo.lock ./
# Create a dummy file to build dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

# Copy the actual source code
COPY container_src/src ./src

# Build the application
# We touch main.rs to ensure cargo rebuilds it
RUN touch src/main.rs && cargo build --release

# Stage 2: Runtime
FROM scratch AS runtime
# FROM alpine AS runtime

WORKDIR /app

# Copy the CA certificates from the build stage (only if using scratch)
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Copy the binary from the build stage
COPY --from=build /app/target/release/cloudflare-container /app/server

EXPOSE 8080

# Run the server
CMD ["./server"]
