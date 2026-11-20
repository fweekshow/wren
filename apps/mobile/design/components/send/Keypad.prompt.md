Borderless 3×4 keypad. Pair with the exported `applyKey(current, key)` helper to build the amount string.

```jsx
<Keypad onKey={k => setAmt(a => applyKey(a, k))} />
```
