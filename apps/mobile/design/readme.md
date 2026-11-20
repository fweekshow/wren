# Wren Design System

## Update — Wren Color, Nov 21 2026 (wins over anything below)
Canvas: "Wren Color" (A + C). Adds color and a bolder face; everything else in the Nov 2026 update still holds.
- **Type:** Bricolage Grotesque replaces Inter Tight. 800 for headlines, the balance and every money number; 700 for names on cards; 400–500 for body. DM Mono replaces Roboto Mono for tickers and percents.
- **Stock colors:** each stock owns one color on every screen (its wallet card, its tile, its Stock page hero): blue #0050FA, lime #C6F432, coral #FFB199, lilac #B9A7FF, mint #7FE0C2, tangerine #FF8A3D, ink #0A0B0D. Cash is always sun #FFD84D. White text on blue and ink; ink text on the rest. RN: `stockColor(symbol)` and `cashColor` in `theme.ts`.
- **What you own = wallet stack.** Holdings and Cash are full-width cards (30px corners, 96px tall) stacked like a wallet, each tucked 26px under the one above. RN: `WalletCard`.
- **What you can send = color tiles.** A two-column grid of solid cards (28px corners) with name, ticker, a small line, the price big and the move. RN: `StockTile`.
- **Stock page:** name, price and chart sit on a hero card in the stock's color; the chart line takes the card's text color. You hold / You sent are tiles below.
- **Moves:** never a solid red pill. On white: an arrow and the percent on a lime (up) or coral (down) chip, ink text. On a colored card: just the arrow and percent in the card's text color. RN: `Change` (`on` prop).
- **Blue ownership changes:** Wren Blue #0050FA is now also a stock color. Base Blue #0000FF stays reserved for the one primary button.
- **Choosing a stock:** never a sideways pill row. Send and Buy start with "What are you sending?" / "What are you buying?": a search field, then every stock as a wallet card (yours first, then all), built to scale past 100 stocks. Amount and Buy show the pick as one card in its color with a Change pill. RN: `StockPickScreen`, `ChosenStock`.
- **Contacts:** your contacts on Wren are color tiles (one steady color per person, `personColor`) with a white initial circle and their latest move ("Bought Apple · 2h") or "Has Wren". Moves are a wallet stack in the color of the stock bought. Not on Wren yet stays a plain list with ink Send pills.
- **Activity:** every send and buy is a wallet card in its stock's color, grouped This week / Earlier: who (or "You bought") and "$50 of Apple · 2h" on the left, where it is as a white pill on the right.
- **Stacked cards** have a 2px white outline so a card's top edge shows on a card of the same color.
- **Logos:** still none. Company logos would replace the letter, pending a decision on sourcing and licensing.

## Update — Nov 2026
- **Bubble cards:** 32px corners with one 8px corner. Yours = Wren Blue #0050FA, white text, tail bottom-right. Theirs = Gray 10, ink text, tail bottom-left. For channel tiles, the amount, message previews and the latest send. Not for lists or settings rows. RN: `components/BubbleCard.tsx`, `components/ChannelTile.tsx`.
- **Headlines:** one per screen, 52px medium, −4% tracking, 98% leading (`type.headline`). Welcome 64 (`type.headlineXl`), name on Sent 96, amount 104.
- **No mascot, anywhere.** The round bird is gone from the app, the design system and the canvas. The logo is the only illustration: the app icon, the splash, and once in the app, 44px top-left on Welcome.
- Screens stay white. One blue button per screen still holds.
- **Sign in:** US and Canada = Privy phone (texted code). Everywhere else = Privy email; the number is confirmed by the connect text they send Wren.

Wren is an iOS app with one job: **pick someone you know and send them a stock.** Wren carries it over.

Made by Basemate (the company name never appears in product UI). Stocks are Coinbase stocks on Base. **Wren is built on Base and borrows Base's visual system (Base Blue, gray ramp, type spec, restraint) — but Wren is its own brand.** The user never sees Base, crypto, or any of that machinery.

## Sources
- Brief pasted by the user (Nov 2026) — the full product, brand, and copy spec. This is the ground truth.
- The round-bird mascot and the earlier orange birds are retired and deleted.
- `assets/logo.png` (1024×902). **The logo and app icon** — a chat bird.
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
- **No emoji. No exclamation marks.** Copy stays quiet.
- Examples: "Who's it for?" · "Search people" · "Has Wren" · "today" · "It's in their Wren." · "They'll get a text."

## VISUAL FOUNDATIONS
Base's rule applies: **lead with monochrome, spotlight one accent.** Grayscale and white space outweigh blue.
- **Canvas:** pure white. Lots of empty space. One action per screen.
- **Color ownership** (strict):
  - **Base Blue #0000FF** — only the one primary button. Base: "reserve Base Blue for the most effective element."
  - **Wren blues** — people and bubbles only: body #0050FA ("Has Wren" dot, selected-face ring), wing #0028C3 (avatar initials), belly #BCCDFB and tint #E3EAFE (avatar faces). The two blues must stay distinct.
  - **Base Green #66C800 / Base Red #FC401F** — only for a value moving up/down, as filled pill chips with ink text.
  - **Base grays:** Gray 0 #FFFFFF canvas, Gray 10 #EEF0F3 cards, Gray 15 #DEE1E7 hairlines, Gray 50 #717886 tertiary, Gray 60 #5B616E secondary, Gray 100 #0A0B0D ink.
  - Base locks these values: don't interpolate new shades. (Exception: #0000C8 pressed-button state.)
- **Type:** Base Sans is Base's proprietary face, so Wren uses Base's published fallbacks. **Inter Tight** for everything; display follows Base's headline spec (medium 500, −3% tracking, 100% leading): total 64, amount 88, person's name 48–56, with a raised small "$" and cents. Body is medium with 140% leading. **Roboto Mono** for tickers, prices, percents.
- **Shapes:** pills (999px) for everything pressable. Squircle cards at 20px. Faces are circles.
- **Cards:** Gray 10 fill, 20px radius, no border, no shadow; rows split by Gray 15 hairlines.
- **Backgrounds:** flat white. No decorative shapes, gradients, opacity layering, textures, glow or blur (Base: "Avoid opacity, layering and other visual effects").
- **Shadows:** none.
- **Imagery:** the chat-bird logo only: app icon, splash, and top-left on Welcome. Faces are initials on Wren-blue tints.
- **Layout:** 390×844. 24px side margins. 54px status bar, 34px home indicator. The one button is pinned 34px above the bottom, full-width, 60px tall.
- **Motion:** quick and small. Press = scale 0.97 + #0000C8 at 120ms. Transitions 220ms ease-out (cubic-bezier(.2,.8,.2,1)).
- **Hover:** none on iOS. Pressed keys get a Gray 10 pill.
- **Selection:** stock pill = 1.5px ink outline; preset = ink fill, white text; person = 2.5px Wren-blue ring; Apple Pay selected = ink pill.

## Logo (the mark)
Source art: `assets/logo.png` — **the logo and the app icon.** A chat bird in flat blue (#002EFB): three white dots, a crest, a beak, and a tail. The `Logo` component renders it. Use it for the home-screen icon, the splash, and small brand marks.

## ICONOGRAPHY
- **Lucide** line icons, 2px stroke, round caps — copied from lucide-static@0.460.0 into `assets/icons/` and inlined in `Icon.jsx`. Set: chevron-left, search, delete, credit-card, x, check. Keep it that small.
- Icons are ink or Gray 50, never colored.
- No emoji. No unicode glyphs as icons. Apple Pay is written as text ("Apple Pay") on an ink pill — the Apple logo is not reproduced.
- The chat-bird logo is the only illustration.

## Index
- `styles.css` — entry; imports `tokens/` (fonts, colors, typography, spacing, base)
- `tokens/` — CSS custom properties
- `guidelines/` — foundation specimen cards (Colors, Type, Spacing, Brand)
- `assets/` — `logo.png` (logo and app icon), `icons/*.svg` (Lucide)
- `components/` — React primitives (below)
- `ui_kits/wren/` — the four-screen iOS flow
- `SKILL.md` — agent skill entry

## Components
- brand: **Logo** (app icon)
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
