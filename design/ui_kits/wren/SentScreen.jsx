function SentScreen({ person, onHome }) {
  const { Phone, PinnedAction, Button, Wren } = window.WrenDesignSystem_f754eb;
  return (
    <Phone label="04 Sent">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 110 }}>
        <div style={{ width: 260, height: 260, borderRadius: '50%', background: 'var(--halo)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 40 }}>
          <Wren size={210} style={{ marginTop: -20 }} />
        </div>
        <div style={{ font: 'var(--type-name)', fontSize: 56, letterSpacing: 'var(--tracking-display)', marginTop: 0 }}>{person.name}</div>
        <div style={{ font: 'var(--type-body-regular)', color: 'var(--text-secondary)', marginTop: 12 }}>{person.hasWren ? 'It’s in their Wren.' : 'They’ll get a text.'}</div>
      </div>
      <PinnedAction><Button full onClick={onHome}>Home</Button></PinnedAction>
    </Phone>
  );
}
window.SentScreen = SentScreen;
