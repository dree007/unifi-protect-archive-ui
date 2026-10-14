# Test-only TLS certificate

Self-signed certificate for `localhost` / `127.0.0.1`, used **only** by the automated tests to run
a fake UniFi Protect server over HTTPS/WSS (e.g. to test `UNIFI_PROTECT_TLS_VERIFY`).
It is not trusted anywhere and protects nothing; the private key is intentionally public.

Regenerate with:

    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
      -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
      -keyout test-only-localhost.key -out test-only-localhost.crt
