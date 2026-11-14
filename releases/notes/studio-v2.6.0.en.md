# studio-v2.6.0

**Nearby devices can be discovered on demand; sign-in remembers the account and happens by itself on every start.**

## Discover

- A Discover button next to Nearby on the NH Studio Devices page and in NH Pocket (the same as Discover in the Desktop's manage window). Every device on the network then answers this computer or phone directly, so devices another relay (such as NH Studio headless) is serving show up too and can be taken over right there. Meant for networks whose Wi-Fi access point does not pass the devices' broadcasts. No sign-in needed.
- The NH Studio headless local WebUI already had a Discover button.

## Sign-in

- NH Studio / NH Pocket remember the account they signed in with (encrypted by the system keychain on Studio, Android secure storage on Pocket) and sign in again on every start, when the server changes and when a token ends; they ask you only when the remembered password no longer works (password changed, account turned off).
- Pasting an app token is gone; goes with New Horizons Desktop v1.10.0 (no more token management on the Relays page).
- After updating from an older version, sign in once more in Settings; from then on it is automatic.

## Fixes

- Label and profile sync did not notice when the server refused the token; it now does.
