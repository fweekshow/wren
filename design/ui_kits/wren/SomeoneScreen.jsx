function SomeoneScreen({ person, onPick }) {
  const { Phone, Wren, SearchField, PersonTile, Icon } = window.WrenDesignSystem_f754eb;
  const [q, setQ] = React.useState('');
  const people = window.WREN_DATA.people.filter(p => p.name.toLowerCase().startsWith(q.trim().toLowerCase()));
  return (
    <Phone label="02 Someone">
      <div style={{ height: 44, display: 'flex', alignItems: 'center', padding: '0 12px' }}>
        <span style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-left" size={28} /></span>
      </div>
      <div style={{ padding: '4px 24px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
        <Wren size={84} />
        <div style={{ font: 'var(--type-title)', fontSize: 32, lineHeight: '38px', letterSpacing: 'var(--tracking-title)', letterSpacing: '-0.01em' }}>Who’s it for?</div>
      </div>
      <div style={{ padding: '20px 24px 8px' }}><SearchField value={q} onChange={setQ} placeholder="Search people" /></div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 24px 40px', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', alignContent: 'start', rowGap: 8 }}>
        {people.map(p => <PersonTile key={p.name} {...p} selected={person && person.name === p.name} onClick={() => onPick(p)} />)}
      </div>
    </Phone>
  );
}
window.SomeoneScreen = SomeoneScreen;
