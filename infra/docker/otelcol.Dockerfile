FROM otel/opentelemetry-collector-contrib:0.154.0

COPY infra/otelcol/config.yaml /etc/otelcol-contrib/config.yaml

CMD ["--config=/etc/otelcol-contrib/config.yaml"]
