FROM rust:1.81-bookworm AS builder
WORKDIR /workspace
COPY . .
RUN cargo build --release --manifest-path cross-platform/services/sync-server/Cargo.toml

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 branchly && mkdir -p /data/objects && chown -R branchly:branchly /data
COPY --from=builder /workspace/cross-platform/target/release/branchly-sync-server /usr/local/bin/branchly-sync-server
USER branchly
ENV BRANCHLY_BIND=0.0.0.0:8080 OBJECT_STORE=local OBJECT_STORE_PATH=/data/objects
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/branchly-sync-server"]
