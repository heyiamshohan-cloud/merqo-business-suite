# Owner-only tools

Two utilities exist for the software owner and for customer support. They are **never**
bundled into the customer installer (`electron-builder.yml` excludes `dist/tools`), and they are
never attached to a public GitHub release — the release workflow keeps them as private
artefacts.

Both are built as genuine single-file Windows executables in CI
(`npm run build:owner-tools` on `windows-latest`, using the Node SEA pipeline). On Linux only
the `.cjs` bundles are produced, because a Linux binary is not a Windows executable and must
never be renamed as one.

---

## 1. MERQO Licence Generator — `MERQO-License-Generator.exe` / `dist/tools/license-generator.cjs`

```
merqo-license keygen  --out <dir> [--passphrase <secret>]
merqo-license issue   --key <private.pem> --org "<name>" --type lifetime|subscription|trial
                      [--device <device-id>] [--expires YYYY-MM-DD] [--owner "<name>"]
                      [--phone <number>] [--email <address>] [--max-devices <n>]
                      [--features "reports,backup"] [--app-major <n>]
                      [--out <file.merqo>] [--passphrase <secret>]
merqo-license inspect --file <file.merqo> [--pub <public.pem>]
merqo-license verify  --file <file.merqo> --pub <public.pem> --device <device-id>
merqo-license device
merqo-license keyid   --pub <public.pem>
```

### Issuing a licence to a customer

1. Ask the customer to send the **device ID** from **Licence → Device ID** (or click *Copy
   device ID*).
2. Issue the licence:

   ```bash
   MERQO-License-Generator.exe issue ^
     --key owner-keys\merqo-private.pem ^
     --org "Karim Traders" --owner "Karim Ahmed" --phone "01711111111" ^
     --type lifetime --device "m1-9f2c…" ^
     --out "licences\karim-traders-2026.merqo"
   ```

3. Verify before sending: `verify --file … --pub owner-keys\merqo-public.pem --device "m1-9f2c…"`.
4. Send the `.merqo` file. The customer activates it in **Licence → Activate from licence file**
   (or pastes the JSON with *Paste a licence*).

For a subscription: `--type subscription --expires 2027-11-03`. For a timed trial without a
device: `--type trial --expires 2026-12-01` (leave `--device` off to allow any machine — not
recommended for paid customers).

### Key handling

- `keygen` writes the private key with mode `0600` and prints the public-key fingerprint.
- The **public** key is embedded in the application at `src/core/licensing/publicKey.ts`.
  Replacing it requires reissuing every licence.
- The **private** key lives only in `owner-keys/` (git-ignored) or on offline media. It must
  never be committed, emailed, copied into the installer, or placed in a release asset.
  CI fails if a private key appears in the repository.
- If the private key is lost, no further licences can be issued for installations that trust the
  current public key. Keep at least two offline backups.

### Verification already performed

Executed on the bundled CLI: `keygen` → `issue --device m1-abc123` → `inspect --pub` (valid) →
`verify` with the correct device (valid: true) → `verify` with a different device
(valid: false, "Licence is bound to a different computer").

---

## 2. MERQO Database Utility — `MERQO-DB-Utility.exe` / `dist/tools/db-utility.cjs`

Support tool for when the application cannot start or when a customer needs an extract without
opening the UI. It writes only in `backup`, `restore` and `vacuum`; documents are never modified.

```
merqo-db info     --db <path>
merqo-db check    --db <path>
merqo-db backup   --db <path> --out <folder> [--label <text>]
merqo-db verify   --file <backup.db>
merqo-db restore  --db <path> --file <backup.db> --yes
merqo-db export   --db <path> --report <key> --from YYYY-MM-DD --to YYYY-MM-DD --out <file.csv>
merqo-db vacuum   --db <path>
merqo-db audit    --db <path> [--limit 25]
merqo-db licenses --db <path>
```

Default Windows database location:
`%APPDATA%\MERQO\data\merqo.db`. Close MERQO before using `vacuum` or `restore`.

### Safe restore procedure

1. `backup --db … --out D:\support\%CUSTOMER%`
2. `verify --file <chosen backup>` — must print `valid : true`
3. `restore --db … --file <chosen backup> --yes` — takes a `.pre-restore-*.db` safety copy,
   removes stale `-wal`/`-shm` sidecars, then copies the backup into place
4. Start MERQO and confirm the dashboard health panel shows balanced journals and reconciled
   inventory.

### Verification already performed

Run against a database created by the core (one product, one customer, one cash sale):
`info` reported schema v1, integrity `ok`, foreign keys `ok` and per-table counts; `check`
reported `journals: balanced`, `inventory: reconciled`, `negative: none`; `backup` produced a
file whose SHA-256 matched `verify`; `export --report daily-sales` wrote a UTF-8-BOM CSV with
Bengali headers; `audit` listed the `sale.create` entry; `licenses` correctly reported
`none / evaluation`.
