function HomeScreen({ onSend }) {
  const { Phone, PinnedAction, Button, Wren, BigNumber, Change, StockList, StockRow } = window.WrenDesignSystem_f754eb;
  const d = window.WREN_DATA;
  const total = d.holdings.reduce((a, h) => a + h.value, 0);
  return (
    <Phone label="01 Home">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 40 }}>
        <Wren size={150} style={{ marginBottom: 6 }} />
        <BigNumber value={total} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <Change value={d.dayChange} /><span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>today</span>
        </div>
      </div>
      <div style={{ padding: '56px 24px 0' }}>
        <StockList>
          {d.holdings.map((h, i) => <StockRow key={h.ticker} {...h} last={i === d.holdings.length - 1} />)}
        </StockList>
      </div>
      <PinnedAction><Button full onClick={onSend}>Send</Button></PinnedAction>
    </Phone>
  );
}
window.HomeScreen = HomeScreen;
