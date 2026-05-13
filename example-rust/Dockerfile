# syntax=docker/dockerfile:1

#
# ---- Builder Stage ----
#
# ARG TARGETPLATFORM is an automatic variable provided by Docker buildx.
# It will be 'linux/amd64' or 'linux/arm64' depending on the --platform flag.
# We are setting a default value for builds that don't use the --platform flag.
ARG TARGETPLATFORM=linux/amd64

# Use a builder image with Rust installed.
FROM rust:1-alpine AS build

# Set build-time arguments that will be used in subsequent commands.
# This makes the value available inside the build stage.
ARG TARGETPLATFORM

# Install Zig, which will act as a universal C cross-compiler,
# then install cargo-zigbuild to integrate it with Cargo.
RUN apk add --no-cache zig build-base && \
    cargo install cargo-zigbuild

# Add the cargo bin directory to the PATH to make cargo-zigbuild available.
ENV PATH="/root/.cargo/bin:${PATH}"

# Set the working directory.
WORKDIR /app

# Copy the Cargo files first to leverage Docker's layer caching.
COPY container_src/Cargo.toml container_src/Cargo.lock ./

# This single RUN command determines the correct Rust target, installs it,
# and builds the project's dependencies using the robust cargo-zigbuild.
RUN case ${TARGETPLATFORM} in \
    "linux/amd64") RUST_TARGET="x86_64-unknown-linux-musl" ;; \
    "linux/arm64") RUST_TARGET="aarch64-unknown-linux-musl" ;; \
    esac && \
    rustup target add ${RUST_TARGET} && \
    mkdir -p src && \
    echo "fn main() {}" > src/main.rs && \
    cargo zigbuild --release --target ${RUST_TARGET}

# Now, copy the actual source code. This will be a separate layer.
COPY container_src/src/ ./src/

# Build the final application and create a stable symlink to the binary.
RUN case ${TARGETPLATFORM} in \
    "linux/amd64") RUST_TARGET="x86_64-unknown-linux-musl" ;; \
    "linux/arm64") RUST_TARGET="aarch64-unknown-linux-musl" ;; \
    esac && \
    rm -f target/${RUST_TARGET}/release/deps/server* && \
    cargo zigbuild --release --target ${RUST_TARGET} && \
    ln -s /app/target/${RUST_TARGET}/release/server /app/server

#
# ---- Final Stage ----
#
# Use a minimal 'scratch' image for the final container.
FROM scratch

# Copy the built binary using the stable symlink created in the build stage.
COPY --from=build /app/server /server

# Expose the port the application will listen on.
EXPOSE 8080

# Set the entrypoint for the container.
CMD ["/server"]
