TEST-ONLY certificates for tests/fixtures/mock-sunshine.ts. Never used outside tests.
Generated like Sunshine's own cert (self-signed, no X509v3 extensions):
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out <n>-key.pem
  openssl req -new -key <n>-key.pem -subj "/CN=Sunshine Gamestream Host" -out <n>.csr
  openssl x509 -req -in <n>.csr -signkey <n>-key.pem -days 36500 -sha256 -extfile /dev/null -out <n>-cert.pem
