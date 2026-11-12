# studio-v2.5.0

**NH Studio, NH Pocket and NH Studio headless take devices over from each other; a device taken over stays in your list; the server WebUI's "Take over" works for Studio too.**

## Taking devices over

- All three are equals: any of them can move a device that another relay is using, without releasing it there first.
- NH Studio (Devices page and Settings > Devices) and NH Pocket: a device in use elsewhere shows "Take over", confirmed before it runs. Settings and the Devices page now follow the same rule (Settings used to offer "Add" for devices marked "Elsewhere").
- NH Studio headless: "Take over" in the local web UI works without the server too, and shows which relay a device is attached to.
- "Take over" on the server's Relays page now works for NH Studio and Pocket (before, the device moved but got no answer and the claim timed out).

## Taken over, and taken back

- A device another Studio, Pocket or headless took over stays in My devices, marked "Taken over by X", with one notification; its recording here stops. "Take back" moves it back at any time. It is never taken back automatically.
- While the owner is away (Studio closed, say), another relay only stands in; when the owner returns it takes the device back automatically.

## FindMe

- Offers are version 2 and carry how many devices the relay serves; current firmware picks a relay by priority, server connection, latency and load.

Pairs with New Horizons OS v1.23.0 and Desktop v1.9.0.
