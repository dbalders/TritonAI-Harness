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

Windows WSL backends keep their credential files inside the selected Linux distribution, separate
from the Windows-native store. Harness inventories that distro-local store through WSL after
preflight. Already-encrypted envelopes must authenticate with the protected desktop key. Any legacy
plaintext requires the same default-cancel upgrade prompt, and only keyed fingerprints for the
selected distro are sent through that backend's one-time bootstrap pipe. Those authorizations live
only for that server process and are consumed after durable migration; replaying old plaintext after
a restart requires another explicit desktop approval.

Before replacing any plaintext, Harness durably writes store-initialization metadata. That marker,
not the unauthenticated envelope prefix, normally distinguishes a first upgrade from an initialized
store whose key is missing. If both metadata files are absent but a credential begins with the
reserved `T3SECRET` envelope magic, Harness also refuses migration instead of generating a new key
and double-encrypting it. That includes truncated, unsupported, and modified version bytes. Legacy
plaintext using that reserved prefix is intentionally rejected because it cannot be safely
distinguished from a damaged encrypted envelope.
If an initialized store's wrapped key is missing, Harness does not offer migration or generate a
replacement key. Restore the OS-protected key state or reset and reconnect the affected integrations.

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
to the keyring and permission to create and remove mode-`0600` lock and temporary files in its
parent directory. Harness serializes fingerprint retirement across server processes; failure to
acquire the lock or persist retirement stops the operation. If a process is forcibly terminated
during retirement, first confirm that no Harness process is using the keyring, then remove the
adjacent `.lock` file before restarting.

Harness also serializes reads and writes for each canonical secret across server processes. This
holds the same mode-`0600` lock from the initial read through migration, replacement, and migration
authorization retirement, preventing a stale legacy read from overwriting a newer value. If a
process is forcibly terminated during a secret operation, first confirm that no Harness process is
using the store, then remove the affected `<name>.bin.lock` file before restarting.

Generate a legacy fingerprint while Harness is stopped. The canonical algorithm is HMAC-SHA-256
with the decoded 32-byte `active` key over, in order: UTF-8 `T3SECRET-LEGACY` followed by a NUL byte,
the UTF-8 canonical secret name, one NUL byte, and the exact legacy file bytes. Base64-encode the
32-byte digest and add it under the matching canonical-name key in `legacySecretFingerprints`. Keep
the keyring mode `0600`, then start Harness. Confirm the entry was removed automatically after the
credential migrated successfully.

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
