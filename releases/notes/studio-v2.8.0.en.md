# studio-v2.8.0

**Support for New Horizons OS v2.1.0: App Studio uses a TypeScript-style language, and installing an app lists its dangerous capabilities and asks for consent.**

## Apps

- App Studio source is now `app.ts` (a subset of TypeScript); the old `.nhs` syntax is no longer accepted. The editor, the reference panel (generated from `nhos.d.ts`, marking the APIs that need consent), the template, the AI prompt, the build panel and the emulator all use the new language, as in New Horizons Desktop v1.12.0.
- Install dialog: when an app declares dangerous capabilities (storage, device settings, streaming, external I2C / UART) it explains them and installs only once you tick the consent, sending it to the device as `grant`; when the board lacks the external I/O (only v1.5.F and v2.0.F have it) it says so before anything is written.
- New error messages `capability_not_granted` and `capability_unsupported`; app packages are validated by their `vm`.
- The device files tool has a new "App Data" scope (the CSV files apps write with `store.append`).
- Goes with New Horizons OS v2.1.0 and New Horizons Desktop v1.12.0. NH Pocket is unchanged and stays at v2.6.0.
