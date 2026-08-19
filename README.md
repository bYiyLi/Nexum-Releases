# Nexum

Nexum connects AI Hosts to controlled local Projects, Files, and Processes.

This repository is a generated public mirror and release execution surface. The canonical project source remains in the private `bYiyLi/Nexum` repository, while the allowlisted Desktop Shell source, Desktop build/qualification code, and user documentation are projected here so public CI can compile and validate the final macOS and Windows installers without access to private Core/Daemon source.

## Install CLI / Headless

```bash
npm install -g https://github.com/bYiyLi/Nexum-Releases/releases/latest/download/nexum-runtime.tgz
nexum help
nexum start
```

See [`docs/README.md`](docs/README.md) for the current usage notes.

## Downloads

Use GitHub Releases for the Universal Runtime and Desktop installers. Production Runtime and installer binaries are not committed to the default branch.

Release targets:

- Universal Runtime / CLI: macOS arm64, Windows x64, Linux x64;
- Desktop: macOS arm64 DMG and Windows x64 per-user NSIS installer, each embedding the same Runtime bytes qualified for that release.

Until Developer ID credentials are configured, macOS test/pre-release DMGs are ad-hoc sealed but not Developer ID signed or notarized. See [`docs/README.md`](docs/README.md) for the trust-state and installation notes.

## Generated Desktop source

The default branch is overwritten from an explicit allowlist in the canonical `Nexum` repository. It is intended for reproducible public Desktop builds and release qualification, not as an independently maintained source of truth. Private Core / Daemon / Web / CLI source is not projected here.
