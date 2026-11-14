# studio-v2.7.0

**Support for the app VM in New Horizons OS v2.0.0: older apps show "needs update", and App Studio compiles to bytecode.**

## Apps

- The NH Studio device Apps page has a new "needs update" state: v2.0.0 firmware no longer runs app packages built before v2.0.0. Such apps are marked "needs update" with a hint to reinstall version 2.0.0 from the App Store.
- New error messages: `needs_update` (the package must be rebuilt) and `app_pool_exhausted` (the app memory pool cannot hold this app).
- App Studio now uses SDK 2: compiling also produces the bytecode image, and `min_os` is at least v2.0.0.
- Goes with New Horizons OS v2.0.0 and New Horizons Desktop v1.11.0. NH Pocket is unchanged and stays at v2.6.0.
