# studio-v2.9.2

**A setting no longer flips back a moment after you change it; a device's on/off settings are "On / Off" again, and everything is sent with Apply.**

## Settings flipping back

- Setting replies (`set_range`, `set_vref`, `set_imu` …) now update the device's status. Before, the new value showed only until the next command's reply, which brought back the old one until the next status poll (the device had changed all along). A refused command writes nothing.

## Switches back to selects

- NH Studio: the device's filter, IMU, raw ADC, stream buffer, update on boot and log are "On / Off" selects, and the external LED mode is its old select; each card's save button sends them as before. Reference voltage: conversion and smart Vref are two selects with one Apply; leak compensation is a select sent with the reference Rfb's Apply. Turning an app on a device on or off is a select plus Apply.
- NH Pocket: the reference voltage's conversion and smart Vref are On / Off segments sent with Apply.
- NH Studio's own preferences (open at login, relay, check for updates on start) are unchanged.

## Other

- Pairs with New Horizons OS v2.1.0 and New Horizons Desktop v1.13.2.
