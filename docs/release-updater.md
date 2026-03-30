# GitHub Releases Auto-Update Setup (Tauri v2)

This project is configured to use GitHub Releases for updater metadata:

- Updater endpoint: `https://github.com/lenohard/toc-generator/releases/latest/download/latest.json`
- Workflow: `.github/workflows/release.yml`
- Trigger: pushing tags like `v0.1.1`

## 1) One-time key generation (local)

```bash
npx tauri signer generate -w ~/.tauri/ocr-bookmarker.key
```

Copy:
- Public key -> `src-tauri/tauri.conf.json` `plugins.updater.pubkey`
- Private key + password -> GitHub Secrets

## 2) Configure GitHub Secrets

In repo settings -> **Secrets and variables** -> **Actions**, add:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## 3) Release a new version

1. Bump versions:
   - `src-tauri/tauri.conf.json` `version`
   - `src-tauri/Cargo.toml` `version`
2. Commit + push
3. Tag and push:

```bash
git tag v0.1.1
git push origin v0.1.1
```

GitHub Action will build DMG, sign updater artifacts, and publish release assets including `latest.json`.

## 4) Client update

In app header, click **Check Update**.
If a new version exists, it will download/install and ask for restart.
