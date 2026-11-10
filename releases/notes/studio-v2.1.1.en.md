# studio-v2.1.1

**Fixes devices moving between Studio and Pocket: a device has one owner. NH Pocket gets Quit.**

## Moving devices

- When another NH Studio or NH Pocket adds a device, the one that managed it now drops it from My devices and stops recording, instead of both keeping it. Being attached to a Hub or the server's FindMe responder does not count as a new owner.
- A managed device that goes quiet is probed to see whether someone else has taken it.
- The screen and the relay engine now share one configuration, so Pocket no longer relays a device while still listing it under Nearby.

## NH Pocket

- Settings has "Quit NH Pocket": it stops the relay service and closes the app completely. Swiping the app away does not end the relay; its state stays in the background.
