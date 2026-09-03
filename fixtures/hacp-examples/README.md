# Vendored HACP canonical valid examples

The five `*.valid.json` files are canonical valid examples from the public HACP
repository (https://github.com/joefeser/hacp, fetched from `main` on
2026-09-03), used as positive control fixtures by `npm run test:artifacts`:
our generated artifacts must validate exactly like the upstream canonical
ones. Machine-readable artefacts are Apache-2.0 upstream; see
`schemas/hacp/v0.1-draft/ATTRIBUTION.md` and `docs/disclosure.md`.
