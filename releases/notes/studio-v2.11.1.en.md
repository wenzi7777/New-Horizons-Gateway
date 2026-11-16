# studio-v2.11.1

**Fixes devices that were connected yet stayed offline in NH Studio, until "Take over" was pressed, when Windows Firewall blocked their data.**

## Cause

Windows Firewall rules are per network category (Private / Public). If NH Studio was allowed on only one of them when it first ran, then on the other kind of network the data a device sends on its own (heartbeats and the stream on UDP 13250) is blocked, while the FindMe traffic Studio sends itself still works: the device kept renewing yet showed offline.

## Fix

- NH Studio first sends one byte from the data port to a device it has just found, which makes the firewall let the device's replies in; for devices it serves it sends it again every 20 s so that permission does not expire. Devices ignore the byte (every firmware version). Headless does the same.
- When a device keeps renewing with this Studio but none of its data arrives for 15 s, the device list and the device page say it may be blocked by this computer's firewall and how to allow it on Windows; headless logs a warning.
- The Windows installer adds a firewall rule allowing NH Studio to receive UDP 13250 and 22346 on every network category, and removes the rules Windows made for it earlier. It asks for administrator approval once, only when the rule is missing, so updates do not ask again; uninstalling removes the rule.

## Manual fix (older versions, or before updating)

In PowerShell run as administrator: `Set-NetFirewallRule -DisplayName "NH Studio" -Profile Any`.

## Other

- NH Pocket is unchanged (2.11.0). Firmware and Desktop need no update.
