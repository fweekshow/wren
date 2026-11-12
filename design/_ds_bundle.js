/* @ds-bundle: {"format":4,"namespace":"WrenDesignSystem_f754eb","components":[{"name":"Wren","sourcePath":"components/brand/Wren.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"Phone","sourcePath":"components/layout/Phone.jsx"},{"name":"PinnedAction","sourcePath":"components/layout/Phone.jsx"},{"name":"BigNumber","sourcePath":"components/money/BigNumber.jsx"},{"name":"Change","sourcePath":"components/money/Change.jsx"},{"name":"StockList","sourcePath":"components/money/StockRow.jsx"},{"name":"StockPicker","sourcePath":"components/money/StockPicker.jsx"},{"name":"StockRow","sourcePath":"components/money/StockRow.jsx"},{"name":"Avatar","sourcePath":"components/people/Avatar.jsx"},{"name":"PersonTile","sourcePath":"components/people/PersonTile.jsx"},{"name":"SearchField","sourcePath":"components/people/SearchField.jsx"},{"name":"WREN_FEE","sourcePath":"components/send/FeeLine.jsx"},{"name":"FeeLine","sourcePath":"components/send/FeeLine.jsx"},{"name":"Keypad","sourcePath":"components/send/Keypad.jsx"},{"name":"PayChoice","sourcePath":"components/send/PayChoice.jsx"},{"name":"Presets","sourcePath":"components/send/Presets.jsx"}],"sourceHashes":{"components/brand/Wren.jsx":"5bb66c1cb486","components/core/Button.jsx":"f95c506f95c5","components/core/Icon.jsx":"676ef14a12fc","components/layout/Phone.jsx":"38261d849885","components/layout/PinnedAction.jsx":"02b0f68f6f5a","components/money/BigNumber.jsx":"fb4987cf52b0","components/money/Change.jsx":"38189e8b9f9a","components/money/StockList.jsx":"5d683a67f8f1","components/money/StockPicker.jsx":"7cd8bb709371","components/money/StockRow.jsx":"f67e344cc7b0","components/people/Avatar.jsx":"8e0ff591730d","components/people/PersonTile.jsx":"ce9bdcfc9053","components/people/SearchField.jsx":"aed2ee479b30","components/send/FeeLine.jsx":"ea227f51bc1b","components/send/Keypad.jsx":"f3d5eca81087","components/send/PayChoice.jsx":"767dd34bc11b","components/send/Presets.jsx":"9acf7bc55373","ui_kits/wren/AmountScreen.jsx":"fbdcaedfcfe7","ui_kits/wren/HomeScreen.jsx":"82ff3593315c","ui_kits/wren/SentScreen.jsx":"8e8473aa5e2b","ui_kits/wren/SomeoneScreen.jsx":"d608e2f7ad24","ui_kits/wren/data.js":"312644556149"},"inlinedExternals":[],"unexposedExports":[{"name":"applyKey","sourcePath":"components/send/Keypad.jsx"},{"name":"totalFor","sourcePath":"components/send/FeeLine.jsx"}]} */

(() => {

const __ds_ns = (window.WrenDesignSystem_f754eb = window.WrenDesignSystem_f754eb || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/brand/Wren.jsx
try { (() => {
// The official Wren art (assets/wren.png). Only the standing pose exists so far; other poses fall back to it.
const SCRIPT = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
const DEFAULT_BASE = SCRIPT ? new URL('assets/', SCRIPT).href : 'assets/';
const ART = {
  perch: 'wren.png',
  point: 'wren.png',
  carry: 'wren.png',
  cheer: 'wren.png'
};
function Wren({
  pose = 'perch',
  size = 160,
  src,
  flip = false,
  style,
  title = 'Wren'
}) {
  const base = typeof window !== 'undefined' && window.WREN_ASSETS || DEFAULT_BASE;
  return /*#__PURE__*/React.createElement("img", {
    src: src || base + (ART[pose] || ART.perch),
    alt: title,
    width: size,
    height: Math.round(size * 537 / 640),
    draggable: false,
    style: {
      display: 'block',
      userSelect: 'none',
      transform: flip ? 'scaleX(-1)' : 'none',
      ...style
    }
  });
}
Object.assign(__ds_scope, { Wren });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/Wren.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
const H = {
  lg: 'var(--button-h-lg)',
  md: 'var(--button-h-md)',
  sm: 'var(--button-h-sm)'
};
const PAD = {
  lg: '0 32px',
  md: '0 22px',
  sm: '0 16px'
};
const FONT = {
  lg: 'var(--type-button)',
  md: '600 16px/22px var(--font-ui)',
  sm: 'var(--type-label)'
};
function Button({
  children,
  variant = 'primary',
  size = 'lg',
  full = false,
  disabled = false,
  icon,
  onClick,
  style
}) {
  const [down, setDown] = React.useState(false);
  const v = {
    primary: {
      background: down ? 'var(--action-pressed)' : 'var(--action)',
      color: 'var(--text-on-action)'
    },
    secondary: {
      background: down ? 'var(--surface-pressed)' : 'var(--surface-card)',
      color: 'var(--text-primary)'
    },
    ghost: {
      background: down ? 'var(--surface-card)' : 'transparent',
      color: 'var(--text-primary)'
    }
  }[variant];
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    disabled: disabled,
    onClick: onClick,
    onPointerDown: () => setDown(true),
    onPointerUp: () => setDown(false),
    onPointerLeave: () => setDown(false),
    style: {
      appearance: 'none',
      border: 0,
      cursor: disabled ? 'default' : 'pointer',
      borderRadius: 'var(--radius-pill)',
      height: H[size],
      padding: PAD[size],
      font: FONT[size],
      width: full ? '100%' : 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      transform: down && !disabled ? 'scale(0.97)' : 'none',
      transition: 'transform var(--dur-fast) var(--ease-out), background var(--dur-fast)',
      opacity: disabled ? 0.32 : 1,
      ...v,
      ...style
    }
  }, icon, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
// Lucide (lucide-static@0.460.0) inner markup, copied verbatim from assets/icons/*.svg
const ICONS = {
  "chevron-left": "<path d=\"m15 18-6-6 6-6\" />",
  "search": "<circle cx=\"11\" cy=\"11\" r=\"8\" /> <path d=\"m21 21-4.3-4.3\" />",
  "delete": "<path d=\"M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z\" /> <path d=\"m12 9 6 6\" /> <path d=\"m18 9-6 6\" />",
  "credit-card": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"5\" rx=\"2\" /> <line x1=\"2\" x2=\"22\" y1=\"10\" y2=\"10\" />",
  "x": "<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />",
  "check": "<path d=\"M20 6 9 17l-5-5\" />"
};
function Icon({
  name,
  size = 24,
  color = 'currentColor',
  strokeWidth = 2,
  style
}) {
  return /*#__PURE__*/React.createElement("svg", {
    "aria-hidden": "true",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      display: 'inline-block',
      flex: 'none',
      ...style
    },
    dangerouslySetInnerHTML: {
      __html: ICONS[name] || ''
    }
  });
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/layout/Phone.jsx
try { (() => {
function Phone({
  children,
  label,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    "data-screen-label": label,
    style: {
      width: 'var(--screen-w)',
      height: 'var(--screen-h)',
      position: 'relative',
      overflow: 'hidden',
      flex: 'none',
      background: 'var(--surface-canvas)',
      borderRadius: 48,
      boxShadow: '0 0 0 1px var(--border-hairline)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 'var(--status-h)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 32px 0 40px',
      font: '600 17px/1 var(--font-ui)',
      color: 'var(--text-primary)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "9:41"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 11,
      display: 'flex',
      gap: 2,
      alignItems: 'flex-end'
    }
  }, [4, 6, 8, 11].map(h => /*#__PURE__*/React.createElement("i", {
    key: h,
    style: {
      width: 3,
      height: h,
      background: 'currentColor',
      borderRadius: 1
    }
  }))), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 25,
      height: 12,
      border: '1.5px solid currentColor',
      borderRadius: 4,
      padding: 1.5,
      opacity: 0.9
    }
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      display: 'block',
      width: '80%',
      height: '100%',
      background: 'currentColor',
      borderRadius: 1.5
    }
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 'var(--status-h) 0 0 0',
      display: 'flex',
      flexDirection: 'column'
    }
  }, children), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 8,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 134,
      height: 5,
      borderRadius: 3,
      background: 'var(--text-primary)'
    }
  }));
}
function PinnedAction({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 24,
      right: 24,
      bottom: 'var(--home-indicator)'
    }
  }, children);
}
Object.assign(__ds_scope, { Phone, PinnedAction });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Phone.jsx", error: String((e && e.message) || e) }); }

// components/layout/PinnedAction.jsx
try { (() => {

Object.assign(__ds_scope, { PinnedAction: __ds_scope.PinnedAction });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/PinnedAction.jsx", error: String((e && e.message) || e) }); }

// components/money/BigNumber.jsx
try { (() => {
function BigNumber({
  value,
  size = 'total',
  cents = true,
  color = 'var(--text-primary)',
  style
}) {
  const n = Number(value) || 0;
  const [whole, frac] = n.toFixed(2).split('.');
  const w = Number(whole).toLocaleString('en-US');
  const font = size === 'amount' ? 'var(--type-amount)' : 'var(--type-total)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      font,
      letterSpacing: 'var(--tracking-display)',
      color,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      fontVariantNumeric: 'tabular-nums',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.55em',
      lineHeight: 1,
      marginTop: '0.08em',
      marginRight: '0.02em'
    }
  }, "$"), /*#__PURE__*/React.createElement("span", null, w), cents && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.55em',
      lineHeight: 1,
      marginTop: '0.08em',
      marginLeft: '0.04em',
      color: 'var(--text-tertiary)'
    }
  }, ".", frac));
}
Object.assign(__ds_scope, { BigNumber });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/money/BigNumber.jsx", error: String((e && e.message) || e) }); }

// components/money/Change.jsx
try { (() => {
function Change({
  value,
  style
}) {
  const up = value >= 0;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      height: 24,
      padding: '0 9px',
      borderRadius: 'var(--radius-pill)',
      background: up ? 'var(--move-up)' : 'var(--move-down)',
      color: 'var(--move-text)',
      font: 'var(--type-percent)',
      letterSpacing: 'var(--tracking-mono)',
      whiteSpace: 'nowrap',
      ...style
    }
  }, up ? '+' : '−', Math.abs(value).toFixed(2), "%");
}
Object.assign(__ds_scope, { Change });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/money/Change.jsx", error: String((e && e.message) || e) }); }

// components/money/StockPicker.jsx
try { (() => {
function StockPicker({
  stocks,
  value,
  onChange,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      justifyContent: 'center',
      flexWrap: 'wrap',
      ...style
    }
  }, stocks.map(s => {
    const on = s.ticker === value;
    return /*#__PURE__*/React.createElement("button", {
      key: s.ticker,
      type: "button",
      onClick: () => onChange && onChange(s.ticker),
      style: {
        appearance: 'none',
        cursor: 'pointer',
        height: 36,
        padding: '0 14px',
        borderRadius: 'var(--radius-pill)',
        border: on ? '1.5px solid var(--text-primary)' : '1.5px solid transparent',
        background: on ? 'var(--surface-canvas)' : 'var(--surface-card)',
        color: 'var(--text-primary)',
        font: 'var(--type-label)',
        display: 'inline-flex',
        alignItems: 'center'
      }
    }, s.name);
  }));
}
Object.assign(__ds_scope, { StockPicker });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/money/StockPicker.jsx", error: String((e && e.message) || e) }); }

// components/money/StockRow.jsx
try { (() => {
function StockRow({
  name,
  ticker,
  value,
  change,
  onClick,
  last = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '16px 20px',
      minHeight: 72,
      borderBottom: last ? 0 : '1px solid var(--border-hairline)',
      cursor: onClick ? 'pointer' : 'default'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--text-primary)'
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ticker)',
      letterSpacing: 'var(--tracking-mono)',
      color: 'var(--text-secondary)',
      marginTop: 2
    }
  }, ticker)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-price)',
      color: 'var(--text-primary)'
    }
  }, "$", Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })), /*#__PURE__*/React.createElement(__ds_scope.Change, {
    value: change
  })));
}
function StockList({
  children,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--surface-card)',
      borderRadius: 'var(--radius-card)',
      overflow: 'hidden',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { StockRow, StockList });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/money/StockRow.jsx", error: String((e && e.message) || e) }); }

// components/money/StockList.jsx
try { (() => {

Object.assign(__ds_scope, { StockList: __ds_scope.StockList });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/money/StockList.jsx", error: String((e && e.message) || e) }); }

// components/people/Avatar.jsx
try { (() => {
const TINTS = ['var(--people-face)', 'var(--people-face-2)'];
function Avatar({
  name = '',
  size = 64,
  style
}) {
  const i = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length;
  return /*#__PURE__*/React.createElement("div", {
    "aria-label": name,
    style: {
      width: size,
      height: size,
      borderRadius: 'var(--radius-face)',
      background: TINTS[i],
      color: 'var(--people-initial)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
      font: `500 ${Math.round(size * 0.4)}px/1 var(--font-display)`,
      letterSpacing: '-0.03em',
      ...style
    }
  }, name.slice(0, 1).toUpperCase());
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/people/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/people/PersonTile.jsx
try { (() => {
function PersonTile({
  name,
  hasWren = false,
  selected = false,
  onClick,
  size = 72
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClick,
    style: {
      appearance: 'none',
      border: 0,
      background: 'transparent',
      cursor: 'pointer',
      padding: '8px 0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: '50%',
      padding: 3,
      boxShadow: selected ? 'inset 0 0 0 2.5px var(--people)' : 'none',
      transition: 'box-shadow var(--dur-fast)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: name,
    size: size
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--text-primary)'
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      font: 'var(--type-caption)',
      color: 'var(--text-secondary)',
      marginTop: -6
    }
  }, hasWren && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: 'var(--people)'
    }
  }), "Has Wren")));
}
Object.assign(__ds_scope, { PersonTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/people/PersonTile.jsx", error: String((e && e.message) || e) }); }

// components/people/SearchField.jsx
try { (() => {
function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  style
}) {
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      height: 48,
      padding: '0 18px',
      borderRadius: 'var(--radius-pill)',
      background: 'var(--surface-card)',
      color: 'var(--text-tertiary)',
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "search",
    size: 20
  }), /*#__PURE__*/React.createElement("input", {
    value: value,
    placeholder: placeholder,
    onChange: e => onChange && onChange(e.target.value),
    style: {
      flex: 1,
      minWidth: 0,
      border: 0,
      outline: 0,
      background: 'transparent',
      font: 'var(--type-body-regular)',
      color: 'var(--text-primary)'
    }
  }));
}
Object.assign(__ds_scope, { SearchField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/people/SearchField.jsx", error: String((e && e.message) || e) }); }

// components/send/FeeLine.jsx
try { (() => {
const usd = n => '$' + n.toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const WREN_FEE = 2.99;
function totalFor(amount, pay) {
  const a = Number(amount) || 0;
  const card = pay === 'card' ? Math.round(a * 0.01 * 100) / 100 : 0;
  return {
    amount: a,
    fee: WREN_FEE,
    card,
    total: a + WREN_FEE + card
  };
}
function FeeLine({
  amount,
  pay = 'applepay',
  style
}) {
  const t = totalFor(amount, pay);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      font: 'var(--type-caption)',
      color: 'var(--text-secondary)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-primary)'
    }
  }, "Total ", /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-ticker)'
    }
  }, usd(t.total))), ' · includes ', usd(t.fee), " Wren", pay === 'card' && /*#__PURE__*/React.createElement(React.Fragment, null, " + ", usd(t.card), " card (1%)"));
}
Object.assign(__ds_scope, { WREN_FEE, totalFor, FeeLine });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/send/FeeLine.jsx", error: String((e && e.message) || e) }); }

// components/send/Keypad.jsx
try { (() => {
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];
function Key({
  k,
  onKey,
  h
}) {
  const [down, setDown] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => onKey && onKey(k),
    onPointerDown: () => setDown(true),
    onPointerUp: () => setDown(false),
    onPointerLeave: () => setDown(false),
    "aria-label": k === 'del' ? 'Delete' : k,
    style: {
      appearance: 'none',
      border: 0,
      cursor: 'pointer',
      height: h,
      borderRadius: 'var(--radius-pill)',
      background: down ? 'var(--surface-card)' : 'transparent',
      color: 'var(--text-primary)',
      font: 'var(--type-key)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background var(--dur-fast)'
    }
  }, k === 'del' ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "delete",
    size: 26
  }) : k);
}
function Keypad({
  onKey,
  keyHeight = 56,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: '2px 8px',
      ...style
    }
  }, KEYS.map(k => /*#__PURE__*/React.createElement(Key, {
    key: k,
    k: k,
    onKey: onKey,
    h: keyHeight
  })));
}
function applyKey(current, k) {
  let s = String(current ?? '');
  if (k === 'del') return s.slice(0, -1);
  if (k === '.') return s.includes('.') ? s : (s || '0') + '.';
  if (s.includes('.') && s.split('.')[1].length >= 2) return s;
  if (s === '0') s = '';
  if (s.replace('.', '').length >= 6) return s;
  return s + k;
}
Object.assign(__ds_scope, { Keypad, applyKey });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/send/Keypad.jsx", error: String((e && e.message) || e) }); }

// components/send/PayChoice.jsx
try { (() => {
function PayChoice({
  value = 'applepay',
  onChange,
  style
}) {
  const opt = (id, label, icon) => {
    const on = value === id;
    return /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => onChange && onChange(id),
      style: {
        appearance: 'none',
        border: 0,
        cursor: 'pointer',
        flex: 1,
        height: 40,
        borderRadius: 'var(--radius-pill)',
        background: on ? id === 'applepay' ? 'var(--text-primary)' : 'var(--surface-canvas)' : 'transparent',
        color: on && id === 'applepay' ? 'var(--white)' : 'var(--text-primary)',
        boxShadow: on && id !== 'applepay' ? 'inset 0 0 0 1.5px var(--text-primary)' : 'none',
        font: 'var(--type-label)',
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        transition: 'background var(--dur-fast)'
      }
    }, icon, label);
  };
  return /*#__PURE__*/React.createElement("div", {
    role: "radiogroup",
    style: {
      display: 'flex',
      gap: 4,
      padding: 4,
      borderRadius: 'var(--radius-pill)',
      background: 'var(--surface-card)',
      ...style
    }
  }, opt('applepay', 'Apple Pay'), opt('card', 'Card', /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "credit-card",
    size: 18
  })));
}
Object.assign(__ds_scope, { PayChoice });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/send/PayChoice.jsx", error: String((e && e.message) || e) }); }

// components/send/Presets.jsx
try { (() => {
function Presets({
  options = [25, 50, 100],
  value,
  onChange,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      justifyContent: 'center',
      ...style
    }
  }, options.map(o => {
    const on = Number(value) === o;
    return /*#__PURE__*/React.createElement("button", {
      key: o,
      type: "button",
      onClick: () => onChange && onChange(o),
      style: {
        appearance: 'none',
        cursor: 'pointer',
        height: 40,
        minWidth: 76,
        padding: '0 16px',
        borderRadius: 'var(--radius-pill)',
        border: 0,
        background: on ? 'var(--text-primary)' : 'var(--surface-card)',
        color: on ? 'var(--white)' : 'var(--text-primary)',
        font: '600 16px/1 var(--font-ui)'
      }
    }, "$", o);
  }));
}
Object.assign(__ds_scope, { Presets });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/send/Presets.jsx", error: String((e && e.message) || e) }); }

// ui_kits/wren/AmountScreen.jsx
try { (() => {
function AmountScreen({
  person,
  ticker,
  setTicker,
  amount,
  setAmount,
  pay,
  setPay,
  onContinue
}) {
  const {
    Phone,
    PinnedAction,
    Button,
    Wren,
    BigNumber,
    StockPicker,
    Presets,
    Keypad,
    applyKey,
    PayChoice,
    FeeLine,
    Avatar,
    Icon
  } = window.WrenDesignSystem_f754eb;
  const n = Number(amount) || 0;
  return /*#__PURE__*/React.createElement(Phone, {
    label: "03 Amount"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 44,
      height: 44,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "chevron-left",
    size: 28
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 8,
      pointerEvents: 'none'
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: person.name,
    size: 28
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body)'
    }
  }, person.name))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 8
    }
  }, /*#__PURE__*/React.createElement(Wren, {
    size: 96,
    style: {
      marginBottom: 6
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 92,
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(BigNumber, {
    value: n,
    size: "amount",
    cents: String(amount).includes('.')
  })), /*#__PURE__*/React.createElement(StockPicker, {
    stocks: window.WREN_DATA.stocks,
    value: ticker,
    onChange: setTicker,
    style: {
      marginTop: 6
    }
  }), /*#__PURE__*/React.createElement(Presets, {
    value: amount,
    onChange: v => setAmount(String(v)),
    style: {
      marginTop: 14
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 32px 0'
    }
  }, /*#__PURE__*/React.createElement(Keypad, {
    keyHeight: 50,
    onKey: k => setAmount(a => applyKey(a, k))
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 24,
      right: 24,
      bottom: 'var(--home-indicator)',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(PayChoice, {
    value: pay,
    onChange: setPay
  }), /*#__PURE__*/React.createElement(FeeLine, {
    amount: n,
    pay: pay
  }), /*#__PURE__*/React.createElement(Button, {
    full: true,
    disabled: n <= 0,
    onClick: onContinue
  }, "Continue")));
}
window.AmountScreen = AmountScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/wren/AmountScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/wren/HomeScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function HomeScreen({
  onSend
}) {
  const {
    Phone,
    PinnedAction,
    Button,
    Wren,
    BigNumber,
    Change,
    StockList,
    StockRow
  } = window.WrenDesignSystem_f754eb;
  const d = window.WREN_DATA;
  const total = d.holdings.reduce((a, h) => a + h.value, 0);
  return /*#__PURE__*/React.createElement(Phone, {
    label: "01 Home"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 40
    }
  }, /*#__PURE__*/React.createElement(Wren, {
    size: 150,
    style: {
      marginBottom: 6
    }
  }), /*#__PURE__*/React.createElement(BigNumber, {
    value: total
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement(Change, {
    value: d.dayChange
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--text-secondary)'
    }
  }, "today"))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '56px 24px 0'
    }
  }, /*#__PURE__*/React.createElement(StockList, null, d.holdings.map((h, i) => /*#__PURE__*/React.createElement(StockRow, _extends({
    key: h.ticker
  }, h, {
    last: i === d.holdings.length - 1
  }))))), /*#__PURE__*/React.createElement(PinnedAction, null, /*#__PURE__*/React.createElement(Button, {
    full: true,
    onClick: onSend
  }, "Send")));
}
window.HomeScreen = HomeScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/wren/HomeScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/wren/SentScreen.jsx
try { (() => {
function SentScreen({
  person,
  onHome
}) {
  const {
    Phone,
    PinnedAction,
    Button,
    Wren
  } = window.WrenDesignSystem_f754eb;
  return /*#__PURE__*/React.createElement(Phone, {
    label: "04 Sent"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 110
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 260,
      height: 260,
      borderRadius: '50%',
      background: 'var(--halo)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 40
    }
  }, /*#__PURE__*/React.createElement(Wren, {
    size: 210,
    style: {
      marginTop: -20
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-name)',
      fontSize: 56,
      letterSpacing: 'var(--tracking-display)',
      marginTop: 0
    }
  }, person.name), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-body-regular)',
      color: 'var(--text-secondary)',
      marginTop: 12
    }
  }, person.hasWren ? 'It’s in their Wren.' : 'They’ll get a text.')), /*#__PURE__*/React.createElement(PinnedAction, null, /*#__PURE__*/React.createElement(Button, {
    full: true,
    onClick: onHome
  }, "Home")));
}
window.SentScreen = SentScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/wren/SentScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/wren/SomeoneScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function SomeoneScreen({
  person,
  onPick
}) {
  const {
    Phone,
    Wren,
    SearchField,
    PersonTile,
    Icon
  } = window.WrenDesignSystem_f754eb;
  const [q, setQ] = React.useState('');
  const people = window.WREN_DATA.people.filter(p => p.name.toLowerCase().startsWith(q.trim().toLowerCase()));
  return /*#__PURE__*/React.createElement(Phone, {
    label: "02 Someone"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 44,
      height: 44,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "chevron-left",
    size: 28
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 24px 0',
      display: 'flex',
      alignItems: 'center',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(Wren, {
    size: 84
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-title)',
      fontSize: 32,
      lineHeight: '38px',
      letterSpacing: 'var(--tracking-title)',
      letterSpacing: '-0.01em'
    }
  }, "Who\u2019s it for?")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 24px 8px'
    }
  }, /*#__PURE__*/React.createElement(SearchField, {
    value: q,
    onChange: setQ,
    placeholder: "Search people"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto',
      padding: '4px 24px 40px',
      display: 'grid',
      gridTemplateColumns: 'repeat(3, minmax(0,1fr))',
      alignContent: 'start',
      rowGap: 8
    }
  }, people.map(p => /*#__PURE__*/React.createElement(PersonTile, _extends({
    key: p.name
  }, p, {
    selected: person && person.name === p.name,
    onClick: () => onPick(p)
  })))));
}
window.SomeoneScreen = SomeoneScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/wren/SomeoneScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/wren/data.js
try { (() => {
window.WREN_DATA = {
  stocks: [{
    name: 'Apple',
    ticker: 'AAPL',
    price: 228.40
  }, {
    name: 'NVIDIA',
    ticker: 'NVDA',
    price: 141.20
  }, {
    name: 'Tesla',
    ticker: 'TSLA',
    price: 252.10
  }, {
    name: 'Microsoft',
    ticker: 'MSFT',
    price: 421.30
  }],
  holdings: [{
    name: 'Apple',
    ticker: 'AAPL',
    value: 612.40,
    change: 1.24
  }, {
    name: 'NVIDIA',
    ticker: 'NVDA',
    value: 418.12,
    change: -0.82
  }, {
    name: 'Tesla',
    ticker: 'TSLA',
    value: 254.00,
    change: 2.31
  }],
  dayChange: 0.84,
  people: [{
    name: 'Mom',
    hasWren: true
  }, {
    name: 'Sam',
    hasWren: true
  }, {
    name: 'Priya'
  }, {
    name: 'Leo'
  }, {
    name: 'Ava',
    hasWren: true
  }, {
    name: 'Noah'
  }, {
    name: 'Maya'
  }, {
    name: 'Jules',
    hasWren: true
  }, {
    name: 'Theo'
  }, {
    name: 'Rosa'
  }, {
    name: 'Ben',
    hasWren: true
  }, {
    name: 'Nina'
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/wren/data.js", error: String((e && e.message) || e) }); }

__ds_ns.Wren = __ds_scope.Wren;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.Phone = __ds_scope.Phone;

__ds_ns.PinnedAction = __ds_scope.PinnedAction;

__ds_ns.BigNumber = __ds_scope.BigNumber;

__ds_ns.Change = __ds_scope.Change;

__ds_ns.StockList = __ds_scope.StockList;

__ds_ns.StockPicker = __ds_scope.StockPicker;

__ds_ns.StockRow = __ds_scope.StockRow;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.PersonTile = __ds_scope.PersonTile;

__ds_ns.SearchField = __ds_scope.SearchField;

__ds_ns.WREN_FEE = __ds_scope.WREN_FEE;

__ds_ns.FeeLine = __ds_scope.FeeLine;

__ds_ns.Keypad = __ds_scope.Keypad;

__ds_ns.PayChoice = __ds_scope.PayChoice;

__ds_ns.Presets = __ds_scope.Presets;

})();
