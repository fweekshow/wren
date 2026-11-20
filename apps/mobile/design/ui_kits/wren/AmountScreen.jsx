function AmountScreen({ person, ticker, setTicker, amount, setAmount, pay, setPay, onContinue }) {
  const { Phone, PinnedAction, Button, Wren, BigNumber, StockPicker, Presets, Keypad, applyKey, PayChoice, FeeLine, Avatar, Icon } = window.WrenDesignSystem_f754eb;
  const n = Number(amount) || 0;
  return (
    <Phone label="03 Amount">
      <div style={{ height: 44, display: 'flex', alignItems: 'center', padding: '0 12px', position: 'relative' }}>
        <span style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-left" size={28} /></span>
        <div style={{ position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
          <Avatar name={person.name} size={28} /><span style={{ font: 'var(--type-body)' }}>{person.name}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
        <Wren size={96} style={{ marginBottom: 6 }} />
        <div style={{ height: 92, display: 'flex', alignItems: 'center' }}>
          <BigNumber value={n} size="amount" cents={String(amount).includes('.')} />
        </div>
        <StockPicker stocks={window.WREN_DATA.stocks} value={ticker} onChange={setTicker} style={{ marginTop: 6 }} />
        <Presets value={amount} onChange={v => setAmount(String(v))} style={{ marginTop: 14 }} />
      </div>
      <div style={{ padding: '10px 32px 0' }}><Keypad keyHeight={50} onKey={k => setAmount(a => applyKey(a, k))} /></div>
      <div style={{ position: 'absolute', left: 24, right: 24, bottom: 'var(--home-indicator)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PayChoice value={pay} onChange={setPay} />
        <FeeLine amount={n} pay={pay} />
        <Button full disabled={n <= 0} onClick={onContinue}>Continue</Button>
      </div>
    </Phone>
  );
}
window.AmountScreen = AmountScreen;
