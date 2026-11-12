# Wren Design System

Wren is an iOS app with one job: **pick someone you know and send them a stock.** The bird is the product — "a little bird told me." Wren carries it over.

Made by Basemate (the company name never appears in product UI). Stocks are Coinbase stocks on Base. **Wren is built on Base and borrows Base's visual system (Base Blue, gray ramp, type spec, restraint) — but Wren is its own brand with its own bird.** The user never sees Base, crypto, or any of that machinery.

## Sources
- Brief pasted by the user (Nov 2026) — the full product, brand, and copy spec. This is the ground truth.
- `uploads/wren.png` → `assets/wren.png` (trimmed, 640px). **The official Wren mascot and logo** (blue). Earlier orange versions are retired.
- Base brand guidelines: https://brand.base.org/color and https://brand.base.org/typography (fetched Nov 2026).
- No codebase or Figma was provided.

## Products
- **Wren iOS app** — four screens: Home, Someone, Amount, Sent. See `ui_kits/wren/`.

## CONTENT FUNDAMENTALS
- **Plain, short, human.** Words a parent would use: "Send", "Apple", "Mom", "Wren". Sentences end with a period and are under six words where possible.
- **Never say:** wallet, gas, USDC, onchain, escrow, claim, token, Basemate. Not even in error states.
- **Names, not handles.** People are first names only ("Mom", "Priya"). No phone numbers, no addresses.
- **Companies by their everyday name.** "Apple", "NVIDIA", "Tesla", "Microsoft". Tickers (AAPL) are secondary, always the mono face.
- **Voice:** second person is implied, rarely written. Wren doesn't talk in first person ("I"); the UI speaks plainly about the other person: "It's in their Wren." / "They'll get a text."
- **Casing:** Sentence case everywhere. Buttons are one word, title case by nature: Send, Continue, Home.
- **Money:** "$50" not "$50.00" while typing; totals show cents. The fee is shown once, inside the total: "Total $52.99 · includes $2.99 Wren". Card adds one line item: "+ $0.50 card (1%)". Never a stack of fees.
- **No emoji. No exclamation marks.** The bird carries the warmth; copy stays quiet.
- Examples: "Who's it for?" · "Search people" · "Has Wren" · "today" · "It's in their Wren." · "They'll get a text."

## VISUAL FOUNDATIONS
Base's rule applies: **lead with monochrome, spotlight one accent.** Grayscale and white space outweigh blue.
- **Canvas:** pure white. Lots of empty space. One action per screen.
- **Color ownership** (strict):
  - **Base Blue #0000FF** — only the one primary button. Base: "reserve Base Blue for the most effective element."
  - **Wren blues** (sampled from the art) — the bird and people only: body #0050FA ("Has Wren" dot, selected-face ring), wing #0028C3 (avatar initials), belly #BCCDFB and tint #E3EAFE (avatar faces, Sent halo). Never recolor the bird to Base Blue; the two blues must stay distinct.
  - **Base Green #66C800 / Base Red #FC401F** — only for a value moving up/down, as filled pill chips with ink text.
  - **Base grays:** Gray 0 #FFFFFF canvas, Gray 10 #EEF0F3 cards, Gray 15 #DEE1E7 hairlines, Gray 50 #717886 tertiary, Gray 60 #5B616E secondary, Gray 100 #0A0B0D ink.
  - Base locks these values: don't interpolate new shades. (Exception: #0000C8 pressed-button state.)
- **Type:** Base Sans is Base's proprietary face, so Wren uses Base's published fallbacks. **Inter Tight** for everything; display follows Base's headline spec (medium 500, −3% tracking, 100% leading): total 64, amount 88, person's name 48–56, with a raised small "$" and cents. Body is medium with 140% leading. **Roboto Mono** for tickers, prices, percents.
- **Shapes:** pills (999px) for everything pressable. Squircle cards at 20px. Faces are circles.
- **Cards:** Gray 10 fill, 20px radius, no border, no shadow; rows split by Gray 15 hairlines.
- **Backgrounds:** flat white. The only decorative shape is the Sent halo, a flat #E3EAFE circle behind Wren. No gradients, opacity layering, textures, glow or blur (Base: "Avoid opacity, layering and other visual effects").
- **Shadows:** none.
- **Imagery:** only Wren. Faces are initials on Wren-blue tints.
- **Layout:** 390×844. 24px side margins. 54px status bar, 34px home indicator. The one button is pinned 34px above the bottom, full-width, 60px tall. Wren appears large, never overlapping the button.
- **Motion:** quick and small. Press = scale 0.97 + #0000C8 at 120ms. Transitions 220ms ease-out (cubic-bezier(.2,.8,.2,1)); Wren hops with slight overshoot (cubic-bezier(.34,1.56,.64,1), 420ms).
- **Hover:** none on iOS. Pressed keys get a Gray 10 pill.
- **Selection:** stock pill = 1.5px ink outline; preset = ink fill, white text; person = 2.5px Wren-blue ring; Apple Pay selected = ink pill.

## Wren (the bird)
Source art: `assets/wren.png` — **the official mascot and logo.** Side profile facing right, flat. Round Wren-blue body (#0050FA), two rounded tail feathers fanning up behind, a deep-blue wing (#0028C3), a periwinkle belly (#BCCDFB), big white oval eyes with black pupils, a small black triangle beak, short black legs with flat feet.
The `Wren` component renders the PNG. Only the standing pose exists; `perch`, `point`, `carry`, `cheer` all fall back to it until new art arrives. Currently shown on Home (standing on the total) and Sent (on the halo).

## ICONOGRAPHY
- **Lucide** line icons, 2px stroke, round caps — copied from lucide-static@0.460.0 into `assets/icons/` and inlined in `Icon.jsx`. Set: chevron-left, search, delete, credit-card, x, check. Keep it that small.
- Icons are ink or Gray 50, never colored.
- No emoji. No unicode glyphs as icons. Apple Pay is written as text ("Apple Pay") on an ink pill — the Apple logo is not reproduced.
- Wren is the only illustration.

## Index
- `styles.css` — entry; imports `tokens/` (fonts, colors, typography, spacing, base)
- `tokens/` — CSS custom properties
- `guidelines/` — foundation specimen cards (Colors, Type, Spacing, Brand)
- `assets/` — `wren.png` (mascot + logo), `wren-mascot.png` (retired orange), `icons/*.svg` (Lucide)
- `components/` — React primitives (below)
- `ui_kits/wren/` — the four-screen iOS flow
- `SKILL.md` — agent skill entry

## Components
- brand: **Wren**
- core: **Button**, **Icon**
- money: **BigNumber**, **Change**, **StockRow**, **StockList**, **StockPicker**
- people: **Avatar**, **PersonTile**, **SearchField**
- send: **Presets**, **Keypad** (+ `applyKey`), **PayChoice**, **FeeLine** (+ `totalFor`, `WREN_FEE`)
- layout: **Phone**, **PinnedAction**

## Data rules
- Stocks: Apple (AAPL), NVIDIA (NVDA), Tesla (TSLA), Microsoft (MSFT). Do not invent others.
- Wren fee $2.99, inside the total. Card adds 1%.
- Contacts are fake first names. No phone numbers, no contract addresses.

## Font note
Inter Tight and Roboto Mono load from Google Fonts (`tokens/fonts.css`) as Base's official fallbacks for Base Sans / Base Mono. If you have a Base Sans license, drop the files in `fonts/` and add @font-face — the stacks already list "Base Sans" / "Base Mono" second.
