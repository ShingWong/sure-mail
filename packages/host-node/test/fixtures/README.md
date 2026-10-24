# test fixtures

- `selfsigned.{key,pem}` — a throwaway self-signed certificate for the
  loopback TLS probe tests (never used outside tests). Regenerate with:

  ```bash
  openssl req -x509 -newkey rsa:2048 -keyout selfsigned.key -out selfsigned.pem \
    -days 36500 -nodes -subj "/CN=sure-mail-test-local" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
  ```
