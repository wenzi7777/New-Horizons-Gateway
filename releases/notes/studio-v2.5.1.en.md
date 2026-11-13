# studio-v2.5.1

**Nearby no longer keeps devices that are switched off.**

## Fixes

- Nearby on the NH Studio Devices page and in NH Pocket: a device not heard (no FindMe) for 60 seconds drops out of the list, and comes back when it is on again. A device switched off used to stay listed until enough FindMes from other devices pushed it out, which with few devices around almost never happened.

The nearby list in the NH Studio headless local WebUI is unchanged (it still shows when each device was last seen).
