# Secret storage

TritonAI Harness keeps provider credentials, OAuth refresh tokens, signing keys, and integration
secrets behind the server-only `ServerSecretStore`. Browser state, model context, plugin tool calls,
and MCP transports receive only the authorized operation result, not the stored credential.

## Desktop protection

The desktop app generates a random 256-bit data-encryption key. Electron Safe Storage protects that
key with the current user's operating-system credential facility:

- macOS: Keychain
- Windows: user-scoped DPAPI
- Linux: Secret Service or KWallet

Harness rejects Linux's `basic_text` fallback and fails to start the backend if secure credential
storage is unavailable. The desktop sends the unlocked data key to its child server through the
inherited one-time bootstrap pipe. It is not placed in command-line arguments or environment
variables.

Secret files remain under `<TRITONAI_HOME>/{userdata|dev}/secrets`, but their contents are versioned
AES-256-GCM envelopes. Every write uses a fresh nonce and authenticates the canonical secret name,
which detects file tampering and ciphertext copied to a different secret name. Files remain mode
`0600` inside a mode `0700` directory.

If credential files already exist when the desktop has no wrapped data key, Harness pauses with a
default-cancel migration prompt. Continue only during a known upgrade from an earlier Harness
release. After explicit approval, Harness captures keyed fingerprints of the exact legacy files and
protects those fingerprints in the OS-wrapped key record. Only matching bytes can migrate. Before
the server starts, Harness flushes and verifies an encrypted temporary file, atomically replaces the
plaintext path, synchronizes the parent directory, and removes that file's fingerprint from the
OS-wrapped record. The server therefore
never receives a reusable desktop migration authorization. Arbitrary plaintext and damaged envelope
headers fail closed; failed encryption, writes, or verification leave the legacy file and its
pending authorization in place and report an error.

Before replacing any plaintext, Harness durably writes store-initialization metadata. That marker,
not the unauthenticated envelope prefix, distinguishes a first upgrade from an initialized store
whose key is missing. This lets arbitrary legacy bytes migrate while damaged envelope headers still
fail closed. If an initialized store's wrapped key is missing, Harness does not offer migration or
generate a replacement key. Restore the OS-protected key state or reset and reconnect the affected
integrations.

## Headless and web server protection

A standalone server has no Electron main process, so it must receive its keyring from an explicitly
managed file. Set `TRITONAI_SECRET_STORE_KEY_FILE` to a file mounted or provisioned by the host's
secret manager. Harness never creates a plaintext fallback key.

The file is JSON:

```json
{
  "version": 1,
  "active": "base64-encoded-32-byte-key",
  "previous": [],
  "legacySecretFingerprints": {}
}
```

Restrict the file to the service account and keep it outside `TRITONAI_HOME`, backups, logs, and the
repository. The active value must decode to exactly 32 bytes. Entries in `previous` use the same
format.

Headless mode does not guess whether non-envelope bytes are legacy plaintext. Existing plaintext
can migrate only when the externally managed keyring includes the keyed fingerprint for that exact
canonical name and value. Otherwise, reset or reconnect the affected integration. This explicit
step prevents a modified envelope header from bypassing authenticated decryption. After the
replacement or deletion is durable, Harness atomically removes the fingerprint from the external
keyring. Successful operations therefore cannot replay the old plaintext after a restart, while a
failed replacement retains its recovery authorization. The service account must have write access
to the keyring; failure to persist retirement stops the operation.

To rotate a headless key, stop Harness, replace the file atomically with a new `active` key while
retaining the old key in `previous`, and restart Harness immediately. The keyring is loaded at server
startup; changing it under a running process does not rotate that process. After the restart,
Harness decrypts old envelopes with fallback keys and lazily re-encrypts them with the active key.
Remove an old fallback only after every retained secret has been read or otherwise rewritten under
the new key, then restart Harness again with the reduced keyring.

## Recovery behavior

The encrypted files are intentionally unusable without their data key. Moving only
`TRITONAI_HOME` to another machine or OS user is not a credential migration. Desktop recovery
requires the corresponding operating-system credential-store state; headless recovery requires the
external keyring. If the key is lost, disconnect or reset the affected integrations and authenticate
again.

Harness fails closed when a key is missing, an envelope version is unknown, or authentication fails.
Errors and telemetry identify only the operation and canonical secret name; they do not include
plaintext, ciphertext, tokens, or encryption keys.
