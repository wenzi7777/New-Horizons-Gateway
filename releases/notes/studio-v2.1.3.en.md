# studio-v2.1.3

**Sign-in prompt when the server refuses the key, and faster hand-over of devices between Studio and Pocket.**

- When the server stops accepting this app's key (revoked, or the server was reset), NH Studio now asks you to sign in again instead of reconnecting every second and failing silently. The reconnect interval also grows to 10 s when a server keeps dropping the connection.
- A device another NH Studio / NH Pocket has taken is dropped from My devices whatever that relay's id is.
- NH Studio also sends its FindMe probe to each network's own broadcast address, so a lost device is noticed sooner on macOS, where the general broadcast could fail for minutes.
