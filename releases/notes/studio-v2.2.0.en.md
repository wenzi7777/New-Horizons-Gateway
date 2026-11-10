# studio-v2.2.0

**TIA-CTL v2.0.F tools in NH Studio: Vref, calibration switch, Rfb measurement, range modes and Vref sweep.**

## Device settings, Hardware

- Vref card: current value, ceiling, power-on value and calibration switch state; set Vref, go back to 330 mV, set the ceiling, switch the calibration switch. Above about 800 mV a reboot can fail to boot, and the page says so.
- Rfb: "Measure Rfb" (optionally at a chosen Vref) lists each row's Rfb, ADC offset and status.
- Range: Raw, Virtual Rfb or Auto, with a reference Rfb and GPIO45 leak compensation. Virtual and Auto unlock as soon as Rfb has been measured.
- Vref sweep: steps Vref at a steady pressure and lists Rfb, Rs median and cells at the rail per step, with the Rs spread and a CSV download. The wait for the reply follows the sweep length (up to 120 s).
- A battery recognised from its ID resistor shows its capacity and charge current, the manual form is hidden, and the battery ID is listed.

Needs firmware v1.21.0 or later (v1.22.0 for Rfb, range and sweep).
