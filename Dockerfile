FROM rust:1-bookworm AS rust-build

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY wit ./wit
RUN cargo build --release -p wasmplane-wasip3-host

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile
COPY src ./src
COPY db ./db
COPY wit ./wit
COPY --from=rust-build /src/target/release/wasmplane-wasip3-host /usr/local/bin/wasmplane-wasip3-host

ENV HOST=0.0.0.0 \
  PORT=8080 \
  RUNTIME_HOST=0.0.0.0 \
  RUNTIME_PORT=8080 \
  WASMPLANE_WASIP3_HOST_BIN=/usr/local/bin/wasmplane-wasip3-host

EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/main.ts"]
