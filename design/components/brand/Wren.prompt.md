Wren, the mascot and logo — the official art as an image. Put it where a moment matters (Home, Sent); never covering the action button.

```jsx
<Wren size={140} />            // Home, standing on the total
<Wren size={200} />            // Sent, on the Wren-tint halo
```

- Feet sit on the bottom edge of the image, so set it straight on top of what it stands on.
- Faces right. `flip` mirrors it.
- Never recolor, outline, shadow or crop. Pose art (point / carry / wings-up) is pending; all poses currently show the standing bird.
- Set `window.WREN_ASSETS = '<path>/assets/'` if the image path can't be inferred.
