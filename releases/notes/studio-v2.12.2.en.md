# studio-v2.12.2

**Buttons in a card's top right no longer spill out of the card, a Vref sweep that cannot compute Rs now says why, and every UI animation now uses an easing curve.**

## Layout

- In NH Studio, the button beside a card's title (such as "Run FindMe" on the FindMe card) stuck out past the card's right edge when the description was long. Now the title wraps and the button keeps its full width; in a narrow window the button moves below the title.
- Also fixed: the top of the device page (name and online status), the Profiles header, and the headers of the App install and IO settings dialogs.

## Vref sweep (TIA-CTL v2.0.F)

- When Rs comes out at fewer than two steps, the panel no longer says "measure Rfb". It asks you to keep the pressure the same for the whole sweep and suggests checking in the CSV that `raw_mv` rises with Vref.
- The old message appears only when there is no Rfb at all. The soldered Rfb is used only for rows without a measured one.

## Animation

- Transitions and animations in NH Studio and NH Pocket now use shared easing curves (the same tokens as the Desktop); animations that should run at constant speed, such as loading spinners, are unchanged.

## Other

- NH Pocket 2.12.2. Pairs with Desktop v1.14.1; no firmware update needed.
