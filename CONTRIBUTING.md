# Contributing

Thanks for your interest. Issues and pull requests are welcome.

- Run `pnpm check` and `cd apps/player-core && cargo test` before sending a pull request;
  on macOS also `pnpm player:mac:test`.
- Engine behaviour is guarded by the golden corpus in `tools/golden`. A change that alters
  rendered frames needs an explanation and updated golden data.
- Keep the safety limiter conservative: changes that raise brightness, flash rate or step
  limits will be reviewed with extra care.
- Do not add vendor-specific HID or firmware protocols; lighting goes through OpenRGB.
- By contributing you agree that your contribution is licensed under the license of the
  directory you change (Apache-2.0, or MIT for `packages/engine`).
