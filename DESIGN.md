# Design system

**Mode:** student form = guided task (warm, calm, mobile-first); staff = Operate (dense, scannable, familiar patterns).

## Palette (brand tokens — fixed)

| Token | Hex | Use |
|---|---|---|
| ink | `#0D0E10` | text, primary buttons, focus ring |
| paper | `#F3F2EE` | page background |
| fire | `#FF5B1F` | accent only: progress bar, submit button (ink text on fire, 6.3:1), active-nav tick, card accent rule in print. **Never text on paper.** |
| ink-2 `#3C3D42`, muted `#63646A` | | secondary text (≥ 4.6:1 on paper) |
| paper-2 `#E9E7E1`, card `#FBFAF7`, line `#D9D6CE`, line-strong `#B9B5AB` | | surfaces and borders |
| ok `#1E6A43`, warn `#7A4F00`, bad `#A8261B` (+ soft tints) | | status only |

## Type

- **Instrument Sans** (variable, self-hosted via @fontsource): all UI.
- **Newsreader** (serif): student headlines, every letter (writing, preview, review cards, print). The letters are the product, so they get the warm voice.
- Fixed rem scale in staff UI; tabular numerals for counts.

## Components

- Pill buttons: primary (ink), fire (final submit only), outline, ghost, danger.
- Fields: 48 px tall, 16 px text (no iOS zoom), ink focus ring.
- Teacher picker: Downshift combobox, inline list (no portal), used teachers shown as "Already chosen · <where>".
- Banners for state (info/ok/warn/bad), Radix dialogs only for irreversible confirmations, side sheets for detail views.
- Notes board: CSS-columns masonry; list mode for scanning.

## Motion

150 ms state transitions only. No page-load choreography, no confetti. `prefers-reduced-motion` disables transitions.

## Known gaps

- Light theme only (school daylight use; staff dashboard could add dark mode later).
